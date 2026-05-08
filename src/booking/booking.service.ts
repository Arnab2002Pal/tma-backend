// booking.service.ts
import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { BookingConfirmation, CreateBookingInput } from './booking.type';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../session/redis.service';
import { BookingStatus, ConsultationType } from '../generated/prisma/enums';
import { ClinicAvailableHours } from '../client/clinic.types';
import { Prisma } from '../generated/prisma/client';

// IST offset in hours — hardcoded, all operations in India
const IST_OFFSET_HOURS = 5.5;

// Booking code expiry — 24 hours
const BOOKING_EXPIRY_HOURS = 24;

// Redis key pattern for sequential counter
// Key: booking_counter:{hotelId}:{YYYYMMDD}  TTL: 48hrs
const COUNTER_KEY = (hotelId: string, dateStr: string) =>
    `booking_counter:${hotelId}:${dateStr}`;

// Counter TTL — 48hrs so counters from yesterday don't collide
const COUNTER_TTL_SECONDS = 48 * 60 * 60;

@Injectable()
export class BookingService {
    private readonly logger = new Logger(BookingService.name);
    private readonly MAX_RETRY_ATTEMPTS = 5;

    constructor(
        private readonly prisma: PrismaService,
        private readonly redisService: RedisService,
    ) { }

    // ─── Main: create booking ────────────────────────────────────────────────────

    async createBooking(input: CreateBookingInput): Promise<BookingConfirmation> {
        const {
            touristPhone,
            clinic,
            triageResult,
            symptomText,
            hotelId,
            roomNumber,
            consultationType = ConsultationType.IN_PERSON,
            language,
        } = input;

        // Phase 1 architecture requires hotel context
        if (!hotelId) {
            throw new BadRequestException('hotelId is required for Phase 1.');
        }

        try {
            /**
             * ---------------------------------------------------------------------
             * Step 1: Prepare booking-related metadata
             * ---------------------------------------------------------------------
             *
             * These operations are independent from the DB insert itself.
             * Compute everything first before entering the atomic write section.
             */

            // Create/update tourist profile
            const tourist = await this.upsertTourist(touristPhone, language);

            // Fetch clinic operating hours
            const clinicHours = await this.getClinicHours(clinic.id);

            // Calculate estimated visit window based on clinic rules
            const visitWindow = this.computeVisitWindow(clinic.id, clinicHours);

            // Booking expiration timestamp
            const expiresAt = new Date(
                Date.now() + BOOKING_EXPIRY_HOURS * 60 * 60 * 1000,
            );

            /**
             * ---------------------------------------------------------------------
             * Step 2: Atomic booking creation loop
             * ---------------------------------------------------------------------
             *
             * Booking code generation is distributed via Redis counters.
             *
             * Although Redis INCR is atomic, collisions are still theoretically
             * possible because:
             * - different hotel counters may generate same visible code
             * - Redis reset/recovery scenarios
             * - historical/manual DB inserts
             *
             * Therefore:
             * - database UNIQUE constraint is treated as the final source of truth
             * - collisions are resolved by retrying booking creation
             *
             * This pattern is fully concurrency-safe.
             */

            let attempts = 0;

            while (attempts < this.MAX_RETRY_ATTEMPTS) {
                try {
                    /**
                     * Generate short tourist-facing booking code.
                     *
                     * Example:
                     * MED-0001
                     * MED-00AF
                     */
                    const bookingCode = await this.generateCodeAtomic(hotelId);

                    /**
                     * Atomic DB insert.
                     *
                     * Prisma + database UNIQUE constraint guarantees:
                     * - either insert succeeds fully
                     * - or fails fully with P2002
                     *
                     * This prevents race conditions under concurrent requests.
                     */
                    const booking = await this.prisma.booking.create({
                        data: {
                            bookingCode,
                            touristId: tourist.id,
                            clinicId: clinic.id,
                            hotelId,
                            roomNumber: roomNumber ?? null,
                            bookingDate: new Date(),
                            careLayer: triageResult.care_layer,
                            severity: triageResult.severity,
                            symptomText,
                            // Store full AI triage payload for audit/history
                            triageResult: JSON.parse(JSON.stringify(triageResult)),
                            specialityNeeded: triageResult.speciality_needed,
                            consultationType,
                            status: BookingStatus.PENDING_PAYMENT,
                            visitWindow,
                            expiresAt,
                            clinicConfirmed: false,
                        },
                    });

                    this.logger.log(
                        `[Booking] Success: ${bookingCode} (Attempt ${attempts + 1})`,
                    );

                    return {
                        bookingCode,
                        displayName: clinic.displayName,
                        visitWindow,
                        feeOpd: clinic.feeOpd,
                        bookingId: booking.id,
                        touristId: tourist.id,
                    };

                } catch (error: any) {
                    /**
                     * Handle UNIQUE constraint collision.
                     *
                     * Prisma P2002 = duplicate unique field.
                     *
                     * If bookingCode already exists:
                     * - generate a new Redis counter
                     * - retry insert
                     *
                     * Extremely rare under normal conditions.
                     */
                    if (
                        error instanceof Prisma.PrismaClientKnownRequestError &&
                        error.code === 'P2002'
                    ) {
                        const target = (error.meta?.target as string[]) || [];

                        if (target.includes('bookingCode')) {
                            attempts++;

                            this.logger.warn(
                                `[Booking] Collision on bookingCode. Retry ${attempts}/${this.MAX_RETRY_ATTEMPTS}`,
                            );

                            continue;
                        }
                    }

                    // Any non-collision DB error should immediately bubble up
                    throw error;
                }
            }

            /**
             * If we exhausted all retries:
             * - Redis may be corrupted/reset
             * - booking code strategy may be flawed
             * - system may be under abnormal load
             */
            throw new InternalServerErrorException(
                '[Booking] Failed to generate a unique booking code after multiple attempts.',
            );

        } catch (error: any) {
            this.logger.error(
                `[Booking] Failed to create booking: ${error.message}`,
                error.stack,
            );

            // Preserve known application exceptions
            if (
                error instanceof BadRequestException ||
                error instanceof InternalServerErrorException
            ) {
                throw error;
            }

            // Prevent leaking internal errors to client
            throw new InternalServerErrorException(
                '[Booking] An unexpected error occurred during booking.',
            );
        }
    }

    /**
     * Generates a short tourist-facing booking code using Redis atomic counters.
     *
     * Strategy:
     * - One counter per hotel per day
     * - Redis INCR guarantees atomic increment across concurrent requests
     * - Counter is encoded into compact base-36 format
     *
     * Example:
     * counter=1   -> MED-0001
     * counter=35  -> MED-000Z
     * counter=36  -> MED-0010
     * counter=100 -> MED-002S
     *
     * IMPORTANT:
     * This method does NOT guarantee global uniqueness by itself.
     *
     * Final uniqueness protection is enforced by:
     * - database UNIQUE constraint
     * - retry-on-collision logic in createBooking()
     */
    private async generateCodeAtomic(hotelId: string): Promise<string> {
        const dateStr = this.getISTDateString();

        // Redis key scoped per hotel + day
        const counterKey = COUNTER_KEY(hotelId, dateStr);

        /**
         * Atomic distributed increment.
         *
         * Redis guarantees:
         * - no duplicate counter values
         * - thread-safe under concurrency
         * - monotonic increments
         */
        const counter = await this.redisService.incrementCounter(
            counterKey,
            COUNTER_TTL_SECONDS,
        );

        // Compact human-friendly encoding
        const encoded = counter
            .toString(36)
            .toUpperCase()
            .padStart(4, '0');

        return `MED-${encoded}`;
    }

    // ─── Visit window ─────────────────────────────────────────────────────────────

    /**
     * Computes a human-readable soft visit window.
     *
     * Rules:
     * - Window is always within clinic open hours
     * - If current IST time is within open hours: "next 3 hours" window capped at close
     * - If booking is made very close to close time (< 1hr remaining): "first thing tomorrow"
     * - Window is guidance only — not a hard appointment
     */
    private computeVisitWindow(clinicId: string, hours: ClinicAvailableHours): string {
        const nowIST = this.getCurrentISTDate();
        const currentHour = nowIST.getHours();
        const currentMinute = nowIST.getMinutes();

        const { open, close } = hours;

        // Currently within open hours
        if (currentHour >= open && currentHour < close) {
            const minutesUntilClose = (close - currentHour) * 60 - currentMinute;

            // Less than 60 minutes until close — suggest tomorrow
            if (minutesUntilClose < 60) {
                return `First thing tomorrow (opens ${this.formatHour(open)})`;
            }

            // Window: now + 30 min to now + 3 hours 30 min, capped at close
            const windowStartHour = currentHour + (currentMinute >= 30 ? 1 : 0);
            const windowEndHour = Math.min(windowStartHour + 3, close);

            return `${this.formatHour(windowStartHour)} – ${this.formatHour(windowEndHour)} today`;
        }

        // Before opening hours — suggest morning window
        if (currentHour < open) {
            return `${this.formatHour(open)} – ${this.formatHour(open + 3)} today`;
        }

        // After close — suggest tomorrow
        return `Tomorrow ${this.formatHour(open)} – ${this.formatHour(open + 3)}`;
    }

    // ─── Tourist upsert ───────────────────────────────────────────────────────────

    /**
     * Find existing tourist by phone or create a new minimal record.
     * Tourist profile is enriched over time — only phone required at booking.
     */
    private async upsertTourist(phone: string, language: string = 'en') {
        return this.prisma.tourist.upsert({
            where: { phone },
            update: {},  // no updates on existing tourist at booking time
            create: {
                phone,
                preferredLanguage: language,
            },
        });
    }

    // ─── Clinic hours lookup ─────────────────────────────────────────────────────

    private async getClinicHours(clinicId: string): Promise<ClinicAvailableHours> {
        const clinic = await this.prisma.clinic.findUniqueOrThrow({
            where: { id: clinicId },
            select: { availableHours: true },
        });
        return clinic.availableHours as unknown as ClinicAvailableHours;
    }

    // ─── IST utilities ────────────────────────────────────────────────────────────

    private getCurrentISTDate(): Date {
        const now = new Date();
        const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
        return new Date(utcMs + IST_OFFSET_HOURS * 60 * 60 * 1000);
    }

    private getISTDateString(): string {
        const ist = this.getCurrentISTDate();
        const y = ist.getFullYear();
        const m = String(ist.getMonth() + 1).padStart(2, '0');
        const d = String(ist.getDate()).padStart(2, '0');
        return `${y}${m}${d}`;
    }

    private formatHour(hour: number): string {
        if (hour === 0 || hour === 24) return '12am';
        if (hour === 12) return '12pm';
        return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
    }
}