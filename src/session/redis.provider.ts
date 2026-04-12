import Redis from 'ioredis';
import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export const RedisProvider: Provider = {
    provide: REDIS_CLIENT,
    inject: [ConfigService],
    useFactory: (config: ConfigService): Redis => {
        const redisUrl = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';

        const client = new Redis(redisUrl, {
            retryStrategy: (times: number) => {
                if (times > 3) return null; // stop retrying, trigger fallback
                return Math.min(times * 100, 500); // 100ms, 200ms, 300ms
            },
            connectTimeout: 2000,
            lazyConnect: true,
        });

        client.on('connect', () => console.log('[Redis] Connected'));
        client.on('error', (err) => console.error('[Redis] Error:', err.message));

        return client;
    },
};