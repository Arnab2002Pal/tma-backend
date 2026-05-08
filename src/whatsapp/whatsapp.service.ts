// Whatsapp.service.ts
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { WhatsappQrHandler } from './whatsapp-qr.handler';
import { AiService } from '../triage/ai.service';
import { TriageService } from '../triage/triage.service';
import { IntakeService } from '../triage/intake.service';
import { ClinicService } from '../client/clinic.service';
import { BookingService } from '../booking/booking.service';
import { RedisService } from '../session/redis.service';
import { WhatsappSendService } from './whatsapp-send.service';
import { TriageResult, WaSession } from '../types/session.types';
import { RankedClinic } from '../client/clinic.types';
import { PrismaService } from '../database/prisma.service';

// ─── Constants ───────────────────────────────────────────────────────────────

const ESCALATION_FOOTER_EN =
    '\n\n⚠️ *If symptoms worsen, you develop fever, difficulty breathing, or severe pain.*';

const AFTER_HOURS_ESCALATION_FOOTER =
    '\n\n⚠️ *If symptoms become serious, call 112 immediately. Clinics open at 8am.*';

// TODO: Use it when we have proper doctor booking flow in place, currently it leads to dead end and confusion for tourists. We can re-enable it later when we have the flow ready.
// const ESCALATION_FOOTER_EN =
//     '\n\n⚠️ *If symptoms worsen, you develop fever, difficulty breathing, or severe pain — reply DOCTOR and I\'ll connect you to a verified clinic immediately.*';

// const AFTER_HOURS_ESCALATION_FOOTER =
//     '\n\n⚠️ *If symptoms become serious, call 112 immediately. Clinics open at 8am — reply DOCTOR then to book.*';

// After-hours session TTL — 2.5 hours in seconds
const AFTER_HOURS_SESSION_TTL = 2.5 * 60 * 60;

// ─── Irrelevant input strike system ──────────────────────────────────────────
// Tracks how many times a tourist sent something that doesn't look like a
// symptom description. Progressive: warn → firm warn → 30min cooldown.
//
// Redis keys:
//   irrelevant_strikes:{phone}   — strike counter, TTL 30min (resets after cooldown)
//   irrelevant_cooldown:{phone}  — exists only during cooldown, TTL 30min
//
// Strike thresholds:
//   1 strike  → friendly nudge
//   2 strikes → firm warning, last chance
//   3 strikes → 30min cooldown
const STRIKE_KEY = (phone: string) => `irrelevant_strikes:${phone}`;
const COOLDOWN_KEY = (phone: string) => `irrelevant_cooldown:${phone}`;
const COOLDOWN_TTL_SECONDS = 30 * 60;   // 30 minutes
const MAX_STRIKES = 3;

// ─── What counts as irrelevant ────────────────────────────────────────────────
// Short single-word inputs or common filler phrases that are clearly not symptoms.
// Emojis-only, greetings, test messages, random words.
// We do NOT flag anything with 3+ words — benefit of the doubt, could be a symptom.
const IRRELEVANT_PATTERNS = [
    /^(hi|hello|hey|hii|helo|yo|ok|okay|k|sure|test|testing|123|abc|lol|haha|👋|😊|🙏|✌️|😄)$/i,
    /^__(gibberish|non_medical)__$/, // internal sentinels — always match
];

function looksIrrelevant(text: string): boolean {
    const trimmed = text.trim();
    // Internal sentinels (__non_medical__, __gibberish__) — always strike, skip all guards
    if (trimmed.startsWith('__') && trimmed.endsWith('__')) {
        return IRRELEVANT_PATTERNS.some(p => p.test(trimmed));
    }
    // Single word or very short input (under 5 chars) with no medical context
    if (trimmed.split(/\s+/).length === 1 && trimmed.length <= 5) {
        return IRRELEVANT_PATTERNS.some(p => p.test(trimmed));
    }
    return false;
}

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
        private readonly qrHandler: WhatsappQrHandler,
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

        } catch (error: any) {
            await this.handleProcessError(from, error);
        }
    }

    // ─── Centralised error handler ────────────────────────────────────────────
    // Separates Meta API errors from generic errors.
    // Error #131030 = recipient not in sandbox allowlist — dev-only, not a code bug.
    // Logged clearly so it doesn't look like a real production issue.
    private async handleProcessError(from: string, error: any): Promise<void> {
        const metaCode: number | undefined = error?.response?.data?.error?.code;
        const metaMessage: string = error?.response?.data?.error?.message ?? '';
        const errorDetails: string = error?.response?.data?.error?.error_data?.details ?? '';

        if (metaCode === 131030) {
            // Sandbox-only restriction — recipient number not added to Meta test allowlist.
            // Fix: developers.facebook.com → WhatsApp → API Setup → add recipient number.
            // This is NOT a code bug. Suppressed from generic error flow.
            this.logger.warn(
                `[WhatsApp] #131030 — Recipient ${from} not in Meta sandbox allowlist. ` +
                `Add this number at: developers.facebook.com → WhatsApp → API Setup → Recipients. ` +
                `This error disappears on production WABA.`
            );
            return; // do NOT attempt to send error message — it will also fail with 131030
        }

        // All other errors — log and notify tourist
        this.logger.error(
            `[WhatsApp] processMessage error for ${from}: ${metaMessage || error.message}`,
            errorDetails,
        );

        try {
            await this.whatsappSend.sendTextMessage(
                from,
                'Sorry, we encountered a technical issue. Please try again. If this is a medical emergency, please call 112 immediately.',
            );
        } catch (sendError: any) {
            this.logger.warn(`[WhatsApp] Failed to send error notification to ${from}`);
        }
    }

    // ─── Strike system ────────────────────────────────────────────────────────
    // Returns true if the tourist is in cooldown (caller should stop processing).
    // Returns false if the message should proceed normally.
    // Increments strike counter on irrelevant input.
    private async checkAndStrikeIrrelevant(from: string, text: string): Promise<boolean> {
        // Check if already in cooldown
        this.logger.log(`[WhatsApp] Checking irrelevant input for ${from}: "${text}"`); 
        const cooldownRaw = await this.sessionService.get(COOLDOWN_KEY(from));
        if (cooldownRaw) {
            const unlocksAt = new Date(parseInt(cooldownRaw, 10));
            const minutesLeft = Math.ceil((unlocksAt.getTime() - Date.now()) / 60000);
            this.logger.warn(`[WhatsApp] ${from} is in irrelevant-input cooldown for ${minutesLeft}min more`);

            await this.whatsappSend.sendTextMessage(
                from,
                `⏳ You've been temporarily restricted due to repeated unrelated messages.\n\n` +
                `Please try again in *${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}*.\n\n` +
                `If you have a genuine medical concern, call *112* now.`,
            );
            return true; // blocked
        }

        if (!looksIrrelevant(text)) {
            return false; // message looks genuine — no strike
        }

        // Irrelevant input — increment strike
        const strikeKey = STRIKE_KEY(from);
        const currentRaw = await this.sessionService.get(strikeKey);
        const current = currentRaw ? parseInt(currentRaw, 10) : 0;
        const strikes = current + 1;

        this.logger.warn(`[WhatsApp] Irrelevant input from ${from} — strike ${strikes}/${MAX_STRIKES}: "${text}"`);

        if (strikes >= MAX_STRIKES) {
            // Strike 3 — apply 30min cooldown, clear strike counter
            const unlocksAt = Date.now() + COOLDOWN_TTL_SECONDS * 1000;
            await this.sessionService.set(COOLDOWN_KEY(from), String(unlocksAt), COOLDOWN_TTL_SECONDS);
            await this.sessionService.del(strikeKey);

            this.logger.warn(`[WhatsApp] ${from} hit max strikes — 30min cooldown applied`);

            await this.whatsappSend.sendTextMessage(
                from,
                `🚫 *Access temporarily restricted.*\n\n` +
                `You've sent several messages that don't appear to be symptom descriptions. ` +
                `This platform is for tourists who need medical help.\n\n` +
                `Please try again in *30 minutes*.\n\n` +
                `⚠️ If you have a *real medical emergency*, call *112* immediately.`,
            );
            return true; // blocked
        }

        // Save updated strike count — TTL matches cooldown window so it auto-resets
        await this.sessionService.set(strikeKey, String(strikes), COOLDOWN_TTL_SECONDS);

        if (strikes === 1) {
            await this.whatsappSend.sendTextMessage(
                from,
                `👋 It looks like your message might not be a symptom description.\n\n` +
                `TMA helps tourists with medical symptoms. To get started, please describe what you're feeling.\n\n` +
                `_Example: "I have a headache and fever since morning" or "my stomach has been hurting for 2 days"_`,
            );
        } else if (strikes === 2) {
            await this.whatsappSend.sendTextMessage(
                from,
                `⚠️ *Last warning* — please describe your symptoms to continue.\n\n` +
                `_Example: "I have a fever and body ache since yesterday"_\n\n` +
                `Continued unrelated messages will temporarily restrict your access.`,
            );
        }

        return true; // irrelevant — don't process further
    }

    // ─── Audio handler ────────────────────────────────────────────────────────
    private async handleAudioMessage(
            from: string,
            message: any,
            session: WaSession,
        ): Promise<void> {

            // Cooldown check — even audio messages count
            const cooldownRaw = await this.sessionService.get(COOLDOWN_KEY(from));
            if (cooldownRaw) {
                const minutesLeft = Math.ceil((parseInt(cooldownRaw, 10) - Date.now()) / 60000);
                await this.whatsappSend.sendTextMessage(
                    from,
                    `⏳ You've been temporarily restricted. Please try again in *${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}*.\n\nFor emergencies, call *112*.`,
                );
                return;
            }

            const mediaUrl = await this.getMediaUrl(message.audio.id);
            const audioBuffer = await this.downloadMedia(mediaUrl);

            const { text, language } = await this.aiService.transcribe(audioBuffer, 'voice.ogg');

            // Gibberish or empty audio — strike system applies here too
            if (!text || this.aiService.isLikelyGibberish(text)) {
                this.logger.warn(`[WhatsApp] Gibberish or empty audio from ${from} — text="${text}"`);

                const blocked = await this.checkAndStrikeIrrelevant(from, text || '__gibberish__');
                if (!blocked) {
                    await this.whatsappSend.sendTextMessage(
                        from,
                        'Sorry, I had trouble understanding your voice message clearly.\n\n' +
                        'Please *type* your symptoms and I\'ll help you right away.',
                    );
                }
                return;
            }

            this.logger.log(`[WhatsApp] Whisper/Google STT → "${text}" (language: ${language})`);

            // ── Circuit breaker gate — before any AI call ────────────────────────────
            // If Anthropic is down, skip medical relevance check entirely.
            // Treat transcribed audio as medical (safe default) and go straight to confirmation.
            // isMedicalSymptom() defaults to true on failure anyway — this just avoids
            // recording another failure against the circuit breaker counter.
            if (this.aiService.isCircuitOpen()) {
                this.logger.warn(`[WhatsApp] Circuit open — skipping isMedicalSymptom for audio from ${from}`);
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
                return;
            }

            // ── Medical relevance check — after transcription, before confirmation ──
            // Catches non-medical audio ("what's the weather", "hello test") that
            // passed gibberish check but isn't a symptom description.
            // isMedicalSymptom() defaults to true on AI failure — never blocks genuine tourists.
            const isMedical = await this.aiService.isMedicalSymptom(text);
            if (!isMedical) {
                this.logger.warn(`[WhatsApp] Non-medical audio detected from ${from} — transcript="${text.substring(0, 80)}"`);
                await this.checkAndStrikeIrrelevant(from, '__non_medical__');
                return;
            }

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
    ) {
        // ── QR prefill message — runs before everything else ────────────────────
        if (this.qrHandler.isStartMessage(text)) {
            await this.qrHandler.handleStart(from, text, session);
            return;
        }

        // ── No hotel context ────────────────────────────────────────────────────
        if (!session.hotelId) {
            await this.qrHandler.sendScanQrMessage(from);
            return;
        }

        // ── Cooldown gate — checked before everything else ───────────────────────
        const cooldownRawText = await this.sessionService.get(COOLDOWN_KEY(from));
        if (cooldownRawText) {
            const minutesLeft = Math.ceil((parseInt(cooldownRawText, 10) - Date.now()) / 60000);
            this.logger.warn(`[WhatsApp] ${from} in cooldown — blocking text message, ${minutesLeft}min remaining`);
            await this.whatsappSend.sendTextMessage(
                from,
                `⏳ You've been temporarily restricted due to repeated unrelated messages.\n\n` +
                `Please try again in *${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}*.\n\n` +
                `If you have a genuine medical concern, call *112* now.`,
            );
            return;
        }

        // ── DOCTOR keyword — bypass strike system entirely ──────────────────────
        // A tourist saying DOCTOR mid-conversation is always genuine intent.
        if (text.toLowerCase() === 'doctor') {
            await this.handleDoctorKeyword(from, session);
            return;
        }

        // ── Q5 number reply — bypass strike system (valid structured input) ─────
        if (session.step === 'AWAITING_Q5') {
            const trimmed = text.trim();
            const parsed = this.intakeService.parseQ5Answer(trimmed);
            if (!parsed) {
                await this.whatsappSend.sendTextMessage(
                    from,
                    'Please reply with numbers between 1–4, separated by commas.\n\n' +
                    '_Example: *1, 3* for nausea and shortness of breath, or *4* if none apply._',
                );
                return;
            }
            session.intakeAnswers.q5 = parsed;
            session.step = 'AWAITING_TRIAGE';
            await this.sessionService.saveSession(session);
            await this.runFinalTriage(from, session);
            return;
        }

        // ── YES/NO during emergency confirm — bypass strike system ──────────────
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

        // ── Strike system — only for free-text symptom entry ────────────────────
        // Only runs when session is at IDLE (fresh symptom entry).
        // Mid-conversation states (Q1–Q4, AWAITING_PAYMENT, etc.) are bypassed above.
        if (session.step === 'IDLE' || !session.step) {
            const blocked = await this.checkAndStrikeIrrelevant(from, text);
            if (blocked) return;
        }

        // ── Fresh symptom text — run emergency check then intake ─────────────────
        await this.runEmergencyCheckAndIntake(from, text, session);
    }

    // ─── DOCTOR keyword handler ───────────────────────────────────────────────
    private async handleDoctorKeyword(from: string, session: WaSession): Promise<void> {
        if (this.clinicService.isAfterHours()) {
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

            case 'AWAITING_PAYMENT':
            case 'CLINIC_SELECTION':
                await this.whatsappSend.sendTextMessage(
                    from,
                    'Your booking is being processed. Please wait while I connect you to a verified clinic.',
                );
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
                hotelId: session.hotelId,
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
        // ── Medical relevance check — covers typed text (audio has its own check) ──
        // Pattern-based looksIrrelevant() catches obvious filler ("hi", "ok").
        // isMedicalSymptom() catches longer but still off-topic text ("what's the weather today").
        // Both run at IDLE entry — mid-conversation steps are already routed before this.
        // Pattern check first (free) — AI check second (costs a Haiku call)
        if (looksIrrelevant(text)) {
            this.logger.warn(`[WhatsApp] Pattern-matched irrelevant text from ${from} — skipping AI check`);
            await this.checkAndStrikeIrrelevant(from, '__non_medical__');
            return;
        }

        // ── Circuit breaker gate ─────────────────────────────────────────────────
        // If AI is down entirely, skip triage and go straight to L3 clinic booking.
        if (this.aiService.isCircuitOpen()) {
            this.logger.warn(`[WhatsApp] Circuit open — skipping triage for ${from}, routing direct to L3`);
            await this.whatsappSend.sendTextMessage(
                from,
                '⚠️ Our assessment system is temporarily unavailable.\n\nLet me connect you to a verified clinic directly.',
            );
            session.symptomText = text;
            session.intakeAnswers = {};
            session.triageResult = {
                severity: 'moderate',
                care_layer: 3,
                summary: 'AI unavailable — routed to clinic directly',
                speciality_needed: 'general physician',
                ai_guidance: '',
                emergency_flag: false,
            };
            await this.sessionService.saveSession(session);
            await this.handleLayer3(from, session, session.triageResult);
            return;
        }

        const isMedical = await this.aiService.isMedicalSymptom(text);
        if (!isMedical) {
            this.logger.warn(`[WhatsApp] Non-medical text from ${from} — input="${text.substring(0, 80)}"`);
            await this.checkAndStrikeIrrelevant(from, '__non_medical__');
            return;
        }

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

        // ── Circuit breaker gate ─────────────────────────────────────────────────
        if (this.aiService.isCircuitOpen()) {
            this.logger.warn(`[WhatsApp] Circuit open — skipping enriched triage for ${from}`);
            await this.whatsappSend.sendTextMessage(
                from,
                '⚠️ Our assessment system is temporarily unavailable.\n\nFinding you a verified clinic directly.',
            );
            const fallbackResult: TriageResult = {
                severity: 'moderate',
                care_layer: 3,
                summary: 'AI unavailable — routed to clinic directly',
                speciality_needed: 'general physician',
                ai_guidance: '',
                emergency_flag: false,
            };
            session.triageResult = fallbackResult;
            await this.sessionService.saveSession(session);
            await this.handleLayer3(from, session, fallbackResult);
            return;
        }

        const result = await this.aiService.runEnrichedTriage(
            session.symptomText,
            session.intakeAnswers,
        );
        
        if (!session.hotelId) {
            this.logger.error(`[WhatsApp] hotelId missing at runFinalTriage for ${from} — session corrupted`);
            await this.whatsappSend.sendTextMessage(
                from,
                'Something went wrong with your session.\n\nPlease scan the QR code in your room again to restart.',
            );
            await this.sessionService.clearSession(from);
            return;
        }

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
        let guidance: string;
        try {
            guidance = await this.aiService.getL1Guidance(
                session.symptomText,
                session.intakeAnswers,
                session.detectedLanguage,
            );
        } catch {
            this.logger.warn(`[WhatsApp] L1 Guidance failed — using static fallback for ${from}`);
            guidance = this.aiService.getStaticAfterHoursGuidance(session.symptomText);
        }

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

        this.logger.log(`[WhatsApp] Running clinic match for ${from} — speciality="${result.speciality_needed}", city="${hotel.city}"`);

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
        // Falls back to static per-symptom guidance if Sonnet is down
        let guidance: string;
        try {
            guidance = await this.aiService.getL1GuidanceAfterHours(
                session.symptomText,
                session.intakeAnswers,
                session.detectedLanguage,
            );
        } catch {
            this.logger.warn(`[WhatsApp] After-hours Sonnet failed — using static fallback for ${from}`);
            guidance = this.aiService.getStaticAfterHoursGuidance(session.symptomText);
        }

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

    // ─── Booking created message ──────────────────────────────────────────────
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