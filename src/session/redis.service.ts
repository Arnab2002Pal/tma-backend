import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.provider';
import { DEFAULT_SESSION, WaSession } from '../types/session.types';

const SESSION_TTL = 86400; // 24 hours
const SESSION_PREFIX = 'wa_session:';

@Injectable()
export class RedisService implements OnModuleInit {
    // In-memory fallback when Redis is unavailable
    private readonly memoryFallback = new Map<string, WaSession>();
    private redisAvailable = false;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private memoryCounters: Map<string, number> = new Map();

    // Generic KV fallback for non-session keys (strikes, cooldowns, etc.)
    // Only used when Redis is unavailable — keys here never expire automatically.
    private readonly memoryKv = new Map<string, string>();

    constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) { }

    async onModuleInit() {
        await this.checkRedisHealth();
    }

    // ─── Session API ────────────────────────────────────────────

    async getSession(phone: string): Promise<WaSession> {
        if (this.redisAvailable) {
            try {
                const raw = await this.redis.get(`${SESSION_PREFIX}${phone}`);
                if (raw) return JSON.parse(raw) as WaSession;
                return DEFAULT_SESSION(phone);
            } catch (err: any) {
                console.error('[Session] Redis read failed, switching to memory fallback:', err.message);
                this.markRedisUnavailable();
            }
        }

        return this.memoryFallback.get(phone) ?? DEFAULT_SESSION(phone);
    }

    async saveSession(session: WaSession): Promise<void> {
        session.lastUpdated = Date.now();

        if (this.redisAvailable) {
            try {
                await this.redis.setex(
                    `${SESSION_PREFIX}${session.phone}`,
                    SESSION_TTL,
                    JSON.stringify(session),
                );
                return;
            } catch (err: any) {
                console.error('[Session] Redis write failed, switching to memory fallback:', err.message);
                this.markRedisUnavailable();
            }
        }

        this.memoryFallback.set(session.phone, session);
    }

    async clearSession(phone: string): Promise<void> {
        if (this.redisAvailable) {
            try {
                await this.redis.del(`${SESSION_PREFIX}${phone}`);
                return;
            } catch {
                this.markRedisUnavailable();
            }
        }
        this.memoryFallback.delete(phone);
    }

    // ─── Session TTL override ───────────────────────────────────
    // Used after after-hours L1 guidance — shorten TTL to 2–3hrs

    async setSessionTTL(phone: string, ttlSeconds: number): Promise<void> {
        if (this.redisAvailable) {
            try {
                await this.redis.expire(`${SESSION_PREFIX}${phone}`, ttlSeconds);
                return;
            } catch (err: any) {
                console.error('[Session] Redis expire failed:', err.message);
            }
        }
        // Memory fallback — TTL not enforced, session will persist until cleared
        // Acceptable: after-hours L1 is a low-risk path
    }

    // ─── Generic KV API ─────────────────────────────────────────
    // Used by strike system, cooldown keys, and any future non-session Redis keys.
    // Keys are stored as-is (no prefix) — callers are responsible for namespacing.
    //
    // get()  → returns string value or null if key doesn't exist
    // set()  → stores value with optional TTL in seconds
    // del()  → deletes key (no-op if missing)
    //
    // Memory fallback behaviour:
    //   - get/set/del all work against memoryKv
    //   - TTL is NOT enforced in memory — keys persist until del() or process restart
    //   - Acceptable for strike/cooldown: worst case tourist gets an extra warning
    //     or cooldown persists a bit longer — not a safety issue

    async get(key: string): Promise<string | null> {
        if (this.redisAvailable) {
            try {
                return await this.redis.get(key);
            } catch (err: any) {
                console.error(`[Session] Redis get failed for key=${key}:`, err.message);
                this.markRedisUnavailable();
            }
        }
        return this.memoryKv.get(key) ?? null;
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (this.redisAvailable) {
            try {
                if (ttlSeconds) {
                    await this.redis.setex(key, ttlSeconds, value);
                } else {
                    await this.redis.set(key, value);
                }
                return;
            } catch (err: any) {
                console.error(`[Session] Redis set failed for key=${key}:`, err.message);
                this.markRedisUnavailable();
            }
        }
        // Memory fallback — TTL not enforced (acceptable, see above)
        this.memoryKv.set(key, value);
    }

    async del(key: string): Promise<void> {
        if (this.redisAvailable) {
            try {
                await this.redis.del(key);
                return;
            } catch (err: any) {
                console.error(`[Session] Redis del failed for key=${key}:`, err.message);
                this.markRedisUnavailable();
            }
        }
        this.memoryKv.delete(key);
    }

    // ─── Dedup ─────────────────────────────────────────────────

    async isDuplicate(wamid: string): Promise<boolean> {
        if (this.redisAvailable) {
            try {
                const result = await this.redis.set(
                    `processed_msg:${wamid}`,
                    '1',
                    'EX',
                    3600,
                    'NX', // only set if not exists
                );
                return result === null; // null means key already existed → duplicate
            } catch {
                return false; // Redis down → allow through, accept rare duplicate
            }
        }
        return false; // memory fallback → allow through
    }

    // ─── Counter (booking code generation) ─────────────────────
    // Atomic INCR — thread-safe, no race conditions
    // Key pattern: booking_counter:{hotelId}:{YYYYMMDD}

    async incrementCounter(key: string, ttlSeconds: number): Promise<number> {
        if (this.redisAvailable) {
            try {
                const value = await this.redis.incr(key);
                // Set TTL only on first increment to avoid resetting on every call
                if (value === 1) {
                    await this.redis.expire(key, ttlSeconds);
                }
                return value;
            } catch (err: any) {
                console.error(`[Session] incrementCounter failed for ${key}:`, err.message);
                // Fall through to in-memory fallback
            }
        }

        // In-memory fallback — safe for single-instance dev
        // In production Redis will always be available
        const current = (this.memoryCounters.get(key) ?? 0) + 1;
        this.memoryCounters.set(key, current);
        return current;
    }

    // ─── Redis health ───────────────────────────────────────────

    private async checkRedisHealth(): Promise<void> {
        try {
            await this.redis.ping();
            this.redisAvailable = true;
            console.log('[Session] Redis healthy');

            // If recovering, drain memory fallback into Redis
            await this.drainFallbackToRedis();
        } catch {
            this.redisAvailable = false;
            console.warn('[Session] Redis unavailable, using in-memory fallback');
            this.scheduleHealthCheck();
        }
    }

    private markRedisUnavailable(): void {
        this.redisAvailable = false;
        this.scheduleHealthCheck();
    }

    private scheduleHealthCheck(): void {
        if (this.healthCheckTimer) return; // already scheduled

        this.healthCheckTimer = setTimeout(async () => {
            this.healthCheckTimer = null;
            await this.checkRedisHealth();
        }, 5000);
    }

    private async drainFallbackToRedis(): Promise<void> {
        if (this.memoryFallback.size === 0) return;

        console.log(`[Session] Draining ${this.memoryFallback.size} sessions from memory to Redis`);

        for (const [phone, session] of this.memoryFallback.entries()) {
            try {
                await this.redis.setex(
                    `${SESSION_PREFIX}${phone}`,
                    SESSION_TTL,
                    JSON.stringify(session),
                );
                this.memoryFallback.delete(phone);
            } catch {
                break; // Redis failed again mid-drain, stop and retry later
            }
        }
    }
}