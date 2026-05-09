// src/whatsapp/whatsapp-qr.handler.ts
//
// Handles QR-initiated WhatsApp sessions.
// Called from whatsapp.service.ts handleTextMessage() before all other routing.
//
// Flow:
//   Tourist scans hotel room QR
//   → browser hits GET /h/:token?room=303
//   → backend builds prefilled wa.me deeplink
//   → WhatsApp opens with: "I need medical help. Room 303 · Taj Bengal · TMA-{hotelId}-303"
//   → tourist taps send
//   → webhook fires → handleTextMessage() → isStartMessage() → handleStart()
//   → session hydrated with hotelId + roomNumber
//   → welcome message sent
//
// Why this file exists:
//   whatsapp.service.ts is already large. QR logic is isolated here for
//   readability and independent testability.

import { Injectable, Logger } from '@nestjs/common';
import { WhatsappSendService } from './whatsapp-send.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../session/redis.service';
import { WaSession } from '../types/session.types';

// Matches the TMA-{hotelId}-{roomNumber} suffix at the end of the prefilled message.
//
// Format:  ...any text... · TMA-{hotelId}-{roomNumber}
//
// Groups:
//   [1] hotelId   — cuid, alphanumeric only (no hyphens in cuid)
//   [2] roomNumber — digits, may include letters for custom room labels
//
// \b before TMA prevents matching a partial word (e.g. "XXTMA-...")
// $ anchor ensures we read from the end — tourist may prepend text but
// the TMA reference must remain at the end to be valid.
//
// Edge cases this handles:
//   - Tourist adds text before the message  → still matches (TMA ref at end)
//   - Tourist removes the TMA ref           → no match → sendScanQrMessage()
//   - Tourist edits middle of message       → still matches if TMA ref intact
//   - Corrupted/partial TMA ref             → no match → sendScanQrMessage()
const PREFILL_PATTERN = /\bTMA-([a-zA-Z0-9]+)-(\S+)$/;

@Injectable()
export class WhatsappQrHandler {
    private readonly logger = new Logger(WhatsappQrHandler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly redisService: RedisService,
        private readonly sendService: WhatsappSendService,
    ) { }

    /**
     * Returns true if the message contains a TMA prefill reference.
     * Called before all other routing in handleTextMessage().
     *
     * Does not validate the hotelId — just checks format.
     * Full validation happens in handleStart().
     */
    isStartMessage(text: string): boolean {
        return PREFILL_PATTERN.test(text.trim());
    }

    /**
     * Handle a QR-initiated message from a tourist.
     *
     * 1. Parse hotelId + roomNumber from TMA prefill reference
     * 2. Validate hotelId exists in DB
     * 3. Hydrate session with hotelId + roomNumber
     * 4. Send welcome message
     *
     * Returns true if session was hydrated successfully.
     * Returns false if parsing or validation failed — caller should not
     * send any additional message (this method sends the fallback itself).
     *
     * Edge cases:
     *   - Malformed TMA ref (regex no-match)  → sendScanQrMessage(), return false
     *   - hotelId not found in DB             → sendScanQrMessage(), return false
     *   - Tourist re-scans while mid-session  → session overwritten, step reset to IDLE
     *     (intentional — re-scan is always a fresh start)
     */
    async handleStart(
        phone: string,
        messageText: string,
        session: WaSession,
    ): Promise<boolean> {
        const match = PREFILL_PATTERN.exec(messageText.trim());

        if (!match) {
            // Should rarely happen — isStartMessage() passed but regex failed.
            // Defensive guard only.
            this.logger.warn(`[QRHandler] Malformed prefill from ${phone}: "${messageText.slice(0, 60)}"`);
            await this.sendScanQrMessage(phone);
            return false;
        }

        const [, hotelId, roomNumber] = match;

        // Validate hotelId against DB — prevents crafted messages from injecting
        // arbitrary hotelIds into sessions
        const hotel = await this.prisma.hotel.findUnique({
            where: { id: hotelId },
            select: { id: true },
        });

        if (!hotel) {
            this.logger.warn(
                `[QRHandler] Invalid hotelId in prefill from ${phone}: ${hotelId}`,
            );
            await this.sendScanQrMessage(phone);
            return false;
        }

        // Hydrate session — overwrite any existing session state.
        // Re-scanning always starts fresh regardless of previous step.
        const updatedSession: WaSession = {
            ...session,
            phone,
            hotelId: hotel.id,
            roomNumber,
            step: 'IDLE',
            intakeAnswers: {},
            symptomText: '',
            lastUpdated: Date.now(),
        };

        await this.redisService.saveSession(updatedSession);

        this.logger.log(
            `[QRHandler] Session hydrated: phone=${phone} hotel=${hotel.id} room=${roomNumber}`,
        );

        await this.sendWelcomeMessage(phone);
        return true;
    }

    /**
     * Fallback message when a tourist messages without a valid QR prefill.
     * Covers: found the number directly, edited the prefill, corrupted QR, etc.
     */
    async sendScanQrMessage(phone: string): Promise<void> {
        await this.sendService.sendTextMessage(
            phone,
            'Welcome to TMA 👋\n\nTo get started, please scan the QR code in your hotel room.\n\nIf you have a medical emergency right now, call *112* immediately.',
        );
    }

    /**
     * Welcome message sent immediately after successful session hydration.
     * First real interaction the tourist has with TMA.
     *
     * Design:
     *   - Warm but brief — tourist may be unwell
     *   - Clear next action — describe symptoms or send voice note
     *   - No menus, no buttons, no choices to make
     *   - Emergency escalation always visible
     */
    async sendWelcomeMessage(phone: string): Promise<void> {
        const message = [
            '👋 Hi! I\'m TMA — your medical assistant in Kolkata.',
            '',
            'I\'m here to help you get the right medical care — quickly and without any hassle.',
            '',
            '*Here\'s how it works:*',
            '1️⃣ Tell me your symptoms — type or send a *voice note* in any language',
            '2️⃣ I\'ll assess your condition and recommend the right care',
            '3️⃣ If you need a doctor, I\'ll show you verified clinics nearby',
            '4️⃣ Pick a clinic and I\'ll book your appointment instantly',
            '',
            '*A few things to know:*',
            '• You can type in Hindi, Bengali, or English — I understand all',
            '• Voice notes work too — just hold the mic button and speak',
            '• All clinics are verified and rated by other tourists',
            '• Your booking comes with a code — just show it at reception',
            '',
            'So, *what are you feeling right now?* Describe your symptoms and I\'ll take it from there. 🩺',
            '',
            '🚨 *Life-threatening emergency? Call 112 immediately* — don\'t wait for me.',
        ].join('\n');

        await this.sendService.sendTextMessage(phone, message);
    }
}