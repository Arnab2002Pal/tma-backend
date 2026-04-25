import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AiService } from 'src/triage/ai.service';
import { TriageService } from 'src/triage/triage.service';
import { IntakeService } from 'src/triage/intake.service';
import { BookingService } from 'src/booking/booking.service';
import { WhatsappSendService } from './whatsapp-send.service';
import { RedisService } from 'src/session/redis.service';
import { TriageResult, WaSession } from 'src/types/session.types';
import { ClinicService } from 'src/client/clinic.service';
import { PrismaService } from 'src/database/prisma.service';
import { RankedClinic } from 'src/client/clinic.types';

// ─── Constants ───────────────────────────────────────────────────────────────

const ESCALATION_FOOTER_EN =
    '\n\n⚠️ *If symptoms worsen, you develop fever, difficulty breathing, or severe pain — reply DOCTOR and I\'ll connect you to a verified clinic immediately.*';

const AFTER_HOURS_ESCALATION_FOOTER =
    '\n\n⚠️ *If symptoms become serious, call 112 immediately. Clinics open at 8am — reply DOCTOR then to book.*';

// After-hours session TTL — 2.5 hours in seconds
const AFTER_HOURS_SESSION_TTL = 2.5 * 60 * 60;

@Injectable()
export class WhatsappService {
    private readonly logger = new Logger(WhatsappService.name);
    private readonly baseUrl: string;
    private readonly token: string;

    constructor(
        private readonly httpService: HttpService,
        private readonly config: ConfigService,
        private readonly aiService: AiService,
        private readonly triageService: TriageService,
        private readonly intakeService: IntakeService,
        private readonly clinicService: ClinicService,
        private readonly bookingService: BookingService,
        private readonly sessionService: RedisService,
        private readonly whatsappSend: WhatsappSendService,
        private readonly prisma: PrismaService,
    ) {
        this.baseUrl = `https://graph.facebook.com/v21.0/${this.config.get('WHATSAPP_PHONE_NUMBER_ID')!}`;
        this.token = this.config.get('WHATSAPP_ACCESS_TOKEN')!;
    }

    // ─── Main entry point ─────────────────────────────────────────────────────

    async processMessage(message: any): Promise<void> {
        const from: string = message.from;
        const messageType: string = message.type;
        this.logger.log(`[WhatsApp] Message from ${from}, type: ${messageType}`);

        try {
            const session = await this.sessionService.getSession(from);

            if (messageType === 'text') {
                const text = message.text.body.trim();
                if (!text) return;
                await this.handleTextMessage(from, text, session);

            } else if (messageType === 'audio') {
                await this.handleAudioMessage(from, message, session);

            } else if (messageType === 'interactive') {
                const interactiveType = message.interactive.type;

                if (interactiveType === 'button_reply') {
                    const buttonId: string = message.interactive.button_reply.id;
                    const buttonLabel: string = message.interactive.button_reply.title;
                    await this.handleButtonReply(from, buttonId, buttonLabel, session);

                } else if (interactiveType === 'list_reply') {
                    const listId: string = message.interactive.list_reply.id;
                    const listTitle: string = message.interactive.list_reply.title;
                    await this.handleListReply(from, listId, listTitle, session);
                }

            } else {
                return; // statuses, reactions — ignore silently
            }

        } catch (error) {
            this.logger.error(`[WhatsApp] processMessage error for ${from}:`, error);
            await this.whatsappSend.sendTextMessage(
                from,
                'Sorry, something went wrong. Please try again or call 112 if this is an emergency.',
            );
        }
    }

    // ─── Audio handler ────────────────────────────────────────────────────────

    private async handleAudioMessage(
        from: string,
        message: any,
        session: WaSession,
    ): Promise<void> {
        const mediaUrl = await this.getMediaUrl(message.audio.id);
        const audioBuffer = await this.downloadMedia(mediaUrl);

        const { text, language } = await this.aiService.transcribe(audioBuffer, 'voice.ogg');

        if (!text || this.aiService.isLikelyGibberish(text)) {
            await this.whatsappSend.sendTextMessage(
                from,
                'Sorry, I had trouble understanding your voice message clearly.\n\n' +
                'Please *type* your symptoms and I\'ll help you right away.',
            );
            return;
        }

        this.logger.log(`[WhatsApp] Whisper → "${text}" (language: ${language})`);

        session.detectedLanguage = language;
        session.symptomText = text;
        session.step = 'AWAITING_SYMPTOM_CONFIRM';
        await this.sessionService.saveSession(session);

        await this.whatsappSend.sendButtonMessage(
            from,
            `🎙️ I understood:\n_"${text}"_\n\nIs this correct?`,
            [
                { id: 'confirm_yes', title: 'Yes, correct' },
                { id: 'confirm_no', title: 'No, let me retype' },
            ],
        );
    }

    // ─── Text message handler ─────────────────────────────────────────────────

    private async handleTextMessage(
        from: string,
        text: string,
        session: WaSession,
    ): Promise<void> {

        // DOCTOR keyword — behaviour depends on time of day
        if (text.toLowerCase() === 'doctor') {
            await this.handleDoctorKeyword(from, session);
            return;
        }

        // Q5 number reply — intercept before emergency check
        if (session.step === 'AWAITING_Q5') {
            const trimmed = text.trim();
            if (['1', '2', '3', '4'].includes(trimmed)) {
                session.intakeAnswers.q5 = this.intakeService.getLabelForAnswer(trimmed);
                session.step = 'AWAITING_TRIAGE';
                await this.sessionService.saveSession(session);
                await this.runFinalTriage(from, session);
            } else {
                await this.whatsappSend.sendTextMessage(
                    from,
                    'Please reply with *1*, *2*, *3*, or *4* to continue.',
                );
            }
            return;
        }

        // AWAITING_EMERGENCY_CONFIRM — YES/NO
        if (session.step === 'AWAITING_EMERGENCY_CONFIRM') {
            const upper = text.toUpperCase().trim();
            if (upper === 'YES') {
                await this.sendLayer4Response(from);
                await this.sessionService.clearSession(from);
            } else if (upper === 'NO') {
                session.step = 'AWAITING_Q1';
                await this.sessionService.saveSession(session);
                await this.intakeService.sendQ1(from);
            } else {
                await this.whatsappSend.sendTextMessage(
                    from,
                    'Please reply *YES* if this is a life-threatening emergency, or *NO* to continue.',
                );
            }
            return;
        }

        // Fresh symptom text — run emergency check then intake
        await this.runEmergencyCheckAndIntake(from, text, session);
    }

    // ─── DOCTOR keyword handler ───────────────────────────────────────────────

    private async handleDoctorKeyword(from: string, session: WaSession): Promise<void> {
        if (this.clinicService.isAfterHours()) {
            // After hours — no clinic matching, give clear guidance
            await this.whatsappSend.sendTextMessage(
                from,
                '🏥 Clinics are currently closed.\n\n' +
                'If this is a *serious emergency*, call *112* immediately.\n\n' +
                'Clinics open at *8am* — reply *DOCTOR* again then and I\'ll find you the nearest one.',
            );
            return;
        }

        // Normal hours — reset session and start fresh for L3
        await this.sessionService.clearSession(from);
        await this.whatsappSend.sendTextMessage(
            from,
            '🏥 Please describe your symptoms and I\'ll find you a verified clinic right away.',
        );
    }

    // ─── Button reply handler ─────────────────────────────────────────────────

    private async handleButtonReply(
        from: string,
        buttonId: string,
        buttonLabel: string,
        session: WaSession,
    ): Promise<void> {

        switch (session.step) {

            case 'AWAITING_SYMPTOM_CONFIRM':
                if (buttonId === 'confirm_yes') {
                    await this.runEmergencyCheckAndIntake(from, session.symptomText, session);
                } else {
                    session.step = 'IDLE';
                    session.symptomText = '';
                    await this.sessionService.saveSession(session);
                    await this.whatsappSend.sendTextMessage(
                        from,
                        'No problem. Please *type* your symptoms and I\'ll help you from there.',
                    );
                }
                break;

            case 'AWAITING_Q1':
                session.intakeAnswers.q1 = this.intakeService.getLabelForAnswer(buttonId);
                session.step = 'AWAITING_Q2';
                await this.sessionService.saveSession(session);
                await this.intakeService.sendQ2(from);
                break;

            case 'AWAITING_Q2':
                session.intakeAnswers.q2 = this.intakeService.getLabelForAnswer(buttonId);
                session.step = 'AWAITING_Q3';
                await this.sessionService.saveSession(session);
                await this.intakeService.sendQ3(from);
                break;

            case 'AWAITING_Q3':
                session.intakeAnswers.q3 = this.intakeService.getLabelForAnswer(buttonId);
                session.step = 'AWAITING_Q4';
                await this.sessionService.saveSession(session);
                await this.intakeService.sendQ4(from);
                break;

            case 'AWAITING_Q4':
                session.intakeAnswers.q4 = this.intakeService.getLabelForAnswer(buttonId);
                session.step = 'AWAITING_Q5';
                await this.sessionService.saveSession(session);
                await this.intakeService.sendQ5(from);
                break;

            default:
                this.logger.warn(`[WhatsApp] Button reply in unexpected state: ${session.step}`);
                await this.whatsappSend.sendTextMessage(
                    from,
                    'Please describe your symptoms to get started.',
                );
                await this.sessionService.clearSession(from);
                break;
        }
    }

    // ─── List reply handler (clinic selection) ────────────────────────────────

    private async handleListReply(
        from: string,
        listId: string,
        listTitle: string,
        session: WaSession,
    ): Promise<void> {

        if (session.step !== 'CLINIC_SELECTION') {
            this.logger.warn(`[WhatsApp] List reply in unexpected state: ${session.step}`);
            await this.whatsappSend.sendTextMessage(
                from,
                'Please describe your symptoms to get started.',
            );
            await this.sessionService.clearSession(from);
            return;
        }

        // listId format: "clinic_{index}"
        const idx = parseInt(listId.replace('clinic_', ''), 10);
        const clinicOptions = session.clinicOptions as RankedClinic[];

        if (isNaN(idx) || !clinicOptions || idx >= clinicOptions.length) {
            this.logger.error(`[WhatsApp] Invalid clinic index from listId: ${listId}`);
            await this.whatsappSend.sendTextMessage(
                from,
                'Something went wrong. Please describe your symptoms again to restart.',
            );
            await this.sessionService.clearSession(from);
            return;
        }

        const selectedClinic = clinicOptions[idx];
        session.selectedClinicId = selectedClinic.id;

        // Guard — hotelId must be present in Phase 1
        // If missing, session was corrupted somewhere upstream
        if (!session.hotelId) {
            this.logger.error(`[WhatsApp] hotelId missing at CLINIC_SELECTION for ${from} — session corrupted`);
            await this.whatsappSend.sendTextMessage(
                from,
                'Something went wrong with your session.\n\n' +
                'Please scan the QR code in your room again to restart.',
            );
            await this.sessionService.clearSession(from);
            return;
        }

        await this.whatsappSend.sendTextMessage(from, '⏳ Creating your booking...');

        try {
            const confirmation = await this.bookingService.createBooking({
                touristPhone: from,
                clinic: selectedClinic,
                triageResult: session.triageResult!,
                symptomText: session.symptomText,
                hotelId: session.hotelId,   // narrowed to string by guard above
                roomNumber: session.roomNumber,
                language: session.detectedLanguage,
            });

            session.bookingId = confirmation.bookingId;
            session.step = 'AWAITING_PAYMENT';
            await this.sessionService.saveSession(session);

            // TODO Step 5 — generate Razorpay payment link and send
            // For now: confirm booking and show code (payment to be wired next)
            await this.sendBookingCreatedMessage(from, confirmation);

        } catch (error) {
            this.logger.error(`[WhatsApp] Booking creation failed for ${from}:`, error);
            await this.whatsappSend.sendTextMessage(
                from,
                'Sorry, I couldn\'t create your booking. Please try again or call 112 if urgent.',
            );
        }
    }

    // ─── Emergency check + intake ─────────────────────────────────────────────

    private async runEmergencyCheckAndIntake(
        from: string,
        text: string,
        session: WaSession,
    ): Promise<void> {
        const emergencyResult = await this.triageService.checkEmergency(text);
        this.logger.log('[WhatsApp] Emergency check:', emergencyResult);

        if (emergencyResult.isEmergency) {
            await this.sendLayer4Response(from);
            await this.sessionService.clearSession(from);
            return;
        }

        if (emergencyResult.reason === 'UNCERTAIN') {
            await this.whatsappSend.sendTextMessage(
                from,
                '⚠️ I want to make sure you get the right help.\n\n' +
                'Are you experiencing a *life-threatening emergency right now?*\n\n' +
                'Reply *YES* to get emergency contacts immediately\n' +
                'Reply *NO* to continue with your symptoms',
            );
            session.step = 'AWAITING_EMERGENCY_CONFIRM';
            await this.sessionService.saveSession(session);
            return;
        }

        // NO_MATCH — save symptom, start Q1
        session.symptomText = text;
        session.step = 'AWAITING_Q1';
        session.intakeAnswers = {};
        await this.sessionService.saveSession(session);
        await this.intakeService.sendQ1(from);
    }

    // ─── Final triage after Q5 ────────────────────────────────────────────────

    private async runFinalTriage(from: string, session: WaSession): Promise<void> {
        await this.whatsappSend.sendTextMessage(from, '🔍 Analysing your symptoms...');

        const result = await this.aiService.runEnrichedTriage(
            session.symptomText,
            session.intakeAnswers,
        );

        session.hotelId = session.hotelId || 'cmobeec9c00008oellhwqz6ax'; // ensure hotelId is string for booking layer, even if missing (should not happen in Phase 1)
        session.triageResult = result;
        this.logger.log(`[WhatsApp] Triage result for ${from}:`, result);

        // Emergency can still emerge from enriched triage
        if (result.emergency_flag || result.care_layer === 4) {
            await this.sendLayer4Response(from);
            await this.sessionService.clearSession(from);
            return;
        }

        // Assessment summary always shown before routing
        await this.sendTriageSummary(from, result);

        // L2 — redirect to L3 with message (Phase 1)
        if (result.care_layer === 2) {
            await this.whatsappSend.sendTextMessage(
                from,
                '🩺 *Video consultation is coming soon.*\n\nFinding you a nearby verified clinic instead...',
            );
            // fall through to L3 handling below
        }

        // L1 — AI self-care guidance
        if (result.care_layer === 1) {
            await this.handleLayer1(from, session);
            return;
        }

        // L3 (and L2 redirect) — clinic matching
        await this.handleLayer3(from, session, result);
    }

    // ─── Layer 1 ──────────────────────────────────────────────────────────────

    private async handleLayer1(from: string, session: WaSession): Promise<void> {
        const guidance = await this.aiService.getL1Guidance(
            session.symptomText,
            session.intakeAnswers,
            session.detectedLanguage,
        );

        await this.whatsappSend.sendTextMessage(from, guidance + ESCALATION_FOOTER_EN);
        session.step = 'IDLE';
        await this.sessionService.saveSession(session);
    }

    // ─── Layer 3 — clinic matching ────────────────────────────────────────────

    private async handleLayer3(
        from: string,
        session: WaSession,
        result: TriageResult,
    ): Promise<void> {

        // After-hours check — must happen before DB query
        if (this.clinicService.isAfterHours()) {
            session.isAfterHours = true;
            await this.sessionService.saveSession(session);
            await this.handleAfterHours(from, session);
            return;
        }

        // Fetch hotel for coordinates and city
        const hotel = session.hotelId
            ? await this.prisma.hotel.findUnique({ where: { id: session.hotelId } })
            : null;

        if (!hotel) {
            // Should not happen in Phase 1 — all tourists enter via hotel QR
            // If it does, session is corrupted — reset and ask to scan QR again
            this.logger.error(`[WhatsApp] No hotel found for hotelId=${session.hotelId} — session corrupted`);
            await this.whatsappSend.sendTextMessage(
                from,
                'Something went wrong with your session.\n\n' +
                'Please scan the QR code in your room again to restart.',
            );
            await this.sessionService.clearSession(from);
            return;
        }

        await this.whatsappSend.sendTextMessage(from, '🔍 Finding verified clinics near you...');

        this.logger.log(`[WhatsApp] Running clinic match for ${from} with speciality "${result.speciality_needed}" in hotel city "${hotel.city}"`);

        const clinics = await this.clinicService.findMatchingClinics({
            city: hotel.city,
            specialityNeeded: result.speciality_needed,
            detectedLanguage: session.detectedLanguage,
            hotelLat: hotel.lat,
            hotelLng: hotel.lng,
        });

        this.logger.log(`[WhatsApp] Found ${clinics.length} clinics for ${from}`);

        if (clinics.length === 0) {
            // No clinics at all — even after GP fallback
            await this.handleAfterHours(from, session);
            return;
        }

        

        // Store clinic options in session for list_reply lookup
        session.clinicOptions = clinics;
        session.step = 'CLINIC_SELECTION';
        await this.sessionService.saveSession(session);

        await this.sendClinicListMessage(from, clinics);
    }

    // ─── After-hours handler ──────────────────────────────────────────────────

    private async handleAfterHours(from: string, session: WaSession): Promise<void> {
        this.logger.log(`[WhatsApp] After-hours path triggered for ${from}`);

        session.isAfterHours = true;
        await this.sessionService.saveSession(session);

        await this.whatsappSend.sendTextMessage(
            from,
            '🌙 *Clinics are currently closed.*\n\n' +
            'I\'m getting you some guidance to help through the night.',
        );

        // Augmented L1 guidance with hotel staff context
        const guidance = await this.aiService.getL1GuidanceAfterHours(
            session.symptomText,
            session.intakeAnswers,
            session.detectedLanguage,
        );

        await this.whatsappSend.sendTextMessage(
            from,
            guidance + AFTER_HOURS_ESCALATION_FOOTER,
        );

        // Alert hotel staff if hotelId + roomNumber present
        if (session.hotelId && session.roomNumber) {
            await this.sendHotelAlert(session.hotelId, session.roomNumber);
        }

        // Shorten session TTL to 2.5 hours — no morning nudge needed
        await this.sessionService.setSessionTTL(from, AFTER_HOURS_SESSION_TTL);

        session.step = 'IDLE';
        await this.sessionService.saveSession(session);
    }

    // ─── Hotel alert ──────────────────────────────────────────────────────────

    private async sendHotelAlert(hotelId: string, roomNumber: string): Promise<void> {
        try {
            const hotel = await this.prisma.hotel.findUnique({
                where: { id: hotelId },
                select: { contactPhone: true, name: true },
            });

            if (!hotel?.contactPhone) {
                this.logger.warn(`[WhatsApp] Hotel ${hotelId} has no contactPhone — skipping alert`);
                return;
            }

            await this.whatsappSend.sendTextMessage(
                hotel.contactPhone,
                `🚨 *TMA Alert — ${hotel.name}*\n\n` +
                `A guest in *Room ${roomNumber}* has reported symptoms and may need assistance.\n\n` +
                `Please check on them. If serious, call 112 immediately.`,
            );

            this.logger.log(`[WhatsApp] Hotel alert sent to ${hotel.contactPhone} for room ${roomNumber}`);
        } catch (error) {
            // Never fail the tourist flow because of hotel alert failure
            this.logger.error('[WhatsApp] Hotel alert failed (non-fatal):', error);
        }
    }

    // ─── Send clinic list ─────────────────────────────────────────────────────

    private async sendClinicListMessage(from: string, clinics: RankedClinic[]): Promise<void> {
        const rows = clinics.map((c, i) => ({
            id: `clinic_${i}`,
            title: c.displayName,
            description:
                `${c.distanceText} · ${this.formatSpeciality(c.speciality)}` +
                ` · ${c.languages.map(l => this.capitalise(l)).join(', ')}` +
                (c.isGpFallback ? '\n(can assess and refer if needed)' : ''),
        }));

        await this.whatsappSend.sendListMessage(
            from,
            '🏥 *Verified clinics near you* — tap to select:',
            [{ title: 'Available Clinics', rows }],
        );
    }

    // ─── Triage summary ───────────────────────────────────────────────────────

    private async sendTriageSummary(from: string, result: TriageResult): Promise<void> {
        const layerLabel: Record<number, string> = {
            1: '🟢 Self-care guidance recommended',
            2: '🟡 Video consultation recommended',
            3: '🟠 Clinic visit recommended',
            4: '🔴 Emergency',
        };

        const message =
            `📋 *Assessment Summary*\n\n` +
            `${layerLabel[result.care_layer]}\n` +
            `📝 *What I found:* ${result.summary}\n` +
            `👨‍⚕️ *Speciality:* ${this.formatSpeciality(result.speciality_needed)}\n` +
            `⚠️ *Severity:* ${this.capitalise(result.severity)}`;

        await this.whatsappSend.sendTextMessage(from, message);
    }

    // ─── Booking created message (pre-payment placeholder) ───────────────────

    private async sendBookingCreatedMessage(
        from: string,
        confirmation: {
            bookingCode: string;
            displayName: string;
            visitWindow: string;
            feeOpd: number;
        },
    ): Promise<void> {
        const feeRs = Math.round(confirmation.feeOpd / 100);

        await this.whatsappSend.sendTextMessage(
            from,
            `✅ *Booking Reserved*\n\n` +
            `Your code: *${confirmation.bookingCode}*\n` +
            `Clinic: ${confirmation.displayName}\n` +
            `Visit window: ${confirmation.visitWindow}\n` +
            `Fee: ₹${feeRs}\n\n` +
            `_Payment link coming shortly..._\n\n` +
            `Show code *${confirmation.bookingCode}* at reception.`,
        );
    }

    // ─── Layer 4 ──────────────────────────────────────────────────────────────

    private async sendLayer4Response(to: string): Promise<void> {
        await this.whatsappSend.sendTextMessage(
            to,
            '🚨 *EMERGENCY DETECTED*\n\n' +
            'Please call *112* immediately.\n\n' +
            'Nearest 24-hour emergency hospitals:\n' +
            '• SSKM Hospital — 244, AJC Bose Rd\n' +
            '• Calcutta Medical College — 88, College St\n\n' +
            '_Stay on the line with 112. Help is on the way._',
        );
    }

    // ─── Media helpers ────────────────────────────────────────────────────────

    async getMediaUrl(mediaId: string): Promise<string> {
        const response = await firstValueFrom(
            this.httpService.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
                headers: { Authorization: `Bearer ${this.token}` },
            }),
        );
        return response.data.url;
    }

    async downloadMedia(url: string): Promise<Buffer> {
        const response = await firstValueFrom(
            this.httpService.get(url, {
                headers: { Authorization: `Bearer ${this.token}` },
                responseType: 'arraybuffer',
            }),
        );
        return Buffer.from(response.data);
    }

    // ─── Formatting helpers ───────────────────────────────────────────────────

    private capitalise(str: string): string {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    private formatSpeciality(speciality: string): string {
        return speciality
            .split(' ')
            .map(w => this.capitalise(w))
            .join(' ');
    }
}