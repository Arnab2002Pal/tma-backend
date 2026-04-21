import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { RedisService } from 'src/session/redis.service';
import { BookingConfirmation, CreateBookingInput } from './booking.type';
import { BookingStatus, ConsultationType } from 'src/generated/prisma/enums';
import { Prisma } from '@prisma/client';
import { ClinicAvailableHours } from 'src/client/clinic.types';

// IST offset in hours — hardcoded, all operations in India
const IST_OFFSET_HOURS = 5.5;

// Booking code expiry — 24 hours
const BOOKING_EXPIRY_HOURS = 24;

// Redis key pattern for sequential counter
// Key: booking_counter:{hotelId}:{YYYYMMDD}  TTL: 48hrs
const COUNTER_KEY = (hotelId: string, dateStr: string) =>
    `booking_counter:${hotelId}:${dateStr}`;

// For independent tourists (no hotel) — use a shared daily counter
const INDEPENDENT_COUNTER_KEY = (dateStr: string) =>
    `booking_counter:independent:${dateStr}`;

// Counter TTL — 48hrs so counters from yesterday don't collide
const COUNTER_TTL_SECONDS = 48 * 60 * 60;

@Injectable()
export class BookingService {
    private readonly logger = new Logger(BookingService.name);

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
        } = input;

        // 1 — Find or create tourist
        const tourist = await this.upsertTourist(touristPhone);

        // 2 — Generate unique MED-XXXX code
        const bookingCode = await this.generateBookingCode(hotelId);

        // 3 — Compute soft visit window from clinic hours
        const visitWindow = this.computeVisitWindow(
            clinic.id,
            await this.getClinicHours(clinic.id),
        );

        // 4 — Booking expiry — 24hrs from now
        const expiresAt = new Date(Date.now() + BOOKING_EXPIRY_HOURS * 60 * 60 * 1000);

        // 5 — Create booking row
        const booking = await this.prisma.booking.create({
            data: {
                bookingCode,
                touristId: tourist.id,
                clinicId: clinic.id,
                hotelId: hotelId ?? null,
                roomNumber: roomNumber ?? null,
                bookingDate: new Date(),
                careLayer: triageResult.care_layer,
                severity: triageResult.severity,
                symptomText,
                triageResult: JSON.parse(JSON.stringify(triageResult)), // Prisma doesn't support nested objects well
                specialityNeeded: triageResult.speciality_needed,
                consultationType,
                status: BookingStatus.PENDING_PAYMENT,
                visitWindow,
                expiresAt,
                clinicConfirmed: false,
            },
        });

        this.logger.log(
            `[Booking] Created ${bookingCode} for tourist ${tourist.id} at clinic ${clinic.id}`,
        );

        return {
            bookingCode,
            displayName: clinic.displayName,
            visitWindow,
            feeOpd: clinic.feeOpd,
            bookingId: booking.id,
            touristId: tourist.id,
        };
    }

    // ─── MED-XXXX generation ─────────────────────────────────────────────────────

    /**
     * Generates a unique MED-XXXX booking code.
     *
     * Strategy: sequential counter per hotel per day stored in Redis.
     * Counter → base-36 encoded → zero-padded to 4 chars → prefixed MED-
     *
     * e.g. counter=1 → "0001" → "MED-0001"
     *      counter=100 → "002S" (base-36) → "MED-002S"
     *
     * Zero collision: same hotel+day always increments the same counter.
     * Different hotel or different day = different counter key.
     * Tourist-facing: short, verbal-friendly, no hotel/room info embedded.
     */
    private async generateBookingCode(hotelId?: string): Promise<string> {
        const dateStr = this.getISTDateString(); // YYYYMMDD
        const counterKey = hotelId
            ? COUNTER_KEY(hotelId, dateStr)
            : INDEPENDENT_COUNTER_KEY(dateStr);

        // Atomic increment in Redis — thread-safe, no race condition
        const counter = await this.redisService.incrementCounter(counterKey, COUNTER_TTL_SECONDS);

        // Encode as base-36 (0-9, A-Z), zero-padded to 4 chars
        const encoded = counter.toString(36).toUpperCase().padStart(4, '0');

        const code = `MED-${encoded}`;

        // Verify uniqueness in DB — extremely rare collision (different hotels,
        // same counter value, same day) but handled defensively
        const existing = await this.prisma.booking.findUnique({
            where: { bookingCode: code },
        });

        if (existing) {
            // Increment once more and retry — statistically will never happen twice
            this.logger.warn(`[Booking] Code collision on ${code} — retrying`);
            const retry = await this.redisService.incrementCounter(counterKey, COUNTER_TTL_SECONDS);
            const retryEncoded = retry.toString(36).toUpperCase().padStart(4, '0');
            return `MED-${retryEncoded}`;
        }

        return code;
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
    private async upsertTourist(phone: string) {
        return this.prisma.tourist.upsert({
            where: { phone },
            update: {},  // no updates on existing tourist at booking time
            create: {
                phone,
                preferredLanguage: 'en', // updated from session detectedLanguage later
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