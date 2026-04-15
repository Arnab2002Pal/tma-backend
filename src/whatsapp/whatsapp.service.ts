import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AiService } from 'src/triage/ai.service';
import { TriageService } from 'src/triage/triage.service';
import { IntakeService } from 'src/triage/intake.service';
import { WhatsappSendService } from './whatsapp-send.service';
import { RedisService } from 'src/session/redis.service';
import { TriageResult, WaSession } from 'src/types/session.types';

const ESCALATION_FOOTER_EN =
    '\n\n⚠️ *If symptoms worsen, you develop fever, difficulty breathing, or severe pain — reply DOCTOR and I\'ll connect you to a verified clinic immediately.*';

@Injectable()
export class WhatsappService {
    private readonly baseUrl: string;
    private readonly token: string;

    constructor(
        private readonly httpService: HttpService,
        private readonly config: ConfigService,
        private readonly aiService: AiService,
        private readonly triageService: TriageService,
        private readonly intakeService: IntakeService,
        private readonly sessionService: RedisService,
        private readonly whatsappSend: WhatsappSendService,
    ) {
        this.baseUrl = `https://graph.facebook.com/v21.0/${this.config.get('WHATSAPP_PHONE_NUMBER_ID')!}`;
        this.token = this.config.get('WHATSAPP_ACCESS_TOKEN')!;
    }

    // ─── Main entry point ───────────────────────────────────────

    async processMessage(message: any): Promise<void> {
        const from: string = message.from;
        const messageType: string = message.type;
        console.log(`[WhatsApp] Message from ${from}, type: ${messageType}`);

        try {
            const session = await this.sessionService.getSession(from);

            if (messageType === 'text') {
                const text = message.text.body.trim();
                if (!text) return;
                await this.handleTextMessage(from, text, session);

            } else if (messageType === 'audio') {
                await this.handleAudioMessage(from, message, session);

            } else if (messageType === 'interactive') {
                const buttonId: string = message.interactive.button_reply.id;
                const buttonLabel: string = message.interactive.button_reply.title;
                await this.handleButtonReply(from, buttonId, buttonLabel, session);

            } else {
                return; // statuses, reactions — ignore silently
            }

        } catch (error) {
            console.error(`[WhatsApp] processMessage error for ${from}:`, error);
            await this.whatsappSend.sendTextMessage(
                from,
                'Sorry, something went wrong. Please try again or call 112 if this is an emergency.',
            );
        }
    }

    // ─── Audio handler ───────────────────────────────────────────

    private async handleAudioMessage(
        from: string,
        message: any,
        session: WaSession,
    ): Promise<void> {
        const mediaUrl = await this.getMediaUrl(message.audio.id);
        const audioBuffer = await this.downloadMedia(mediaUrl);

        const { text, language } = await this.aiService.transcribe(audioBuffer, 'voice.ogg');

        // Gibberish check — ask tourist to type instead
        if (!text || this.aiService.isLikelyGibberish(text)) {
            await this.whatsappSend.sendTextMessage(
                from,
                'Sorry, I had trouble understanding your voice message clearly.\n\n' +
                'Please *type* your symptoms and I\'ll help you right away.',
            );
            return;
        }

        console.log(`[WhatsApp] Whisper → "${text}" (language: ${language})`);

        // Save detected language to session
        session.detectedLanguage = language;
        session.symptomText = text;
        await this.sessionService.saveSession(session);

        // Show tourist what was understood — confirm before running triage
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

    // ─── Text message handler ────────────────────────────────────

    private async handleTextMessage(
        from: string,
        text: string,
        session: WaSession,
    ): Promise<void> {

        // DOCTOR keyword — reset and go to L3 from any state
        if (text.toLowerCase() === 'doctor') {
            await this.sessionService.clearSession(from);
            await this.whatsappSend.sendTextMessage(
                from,
                '🏥 Connecting you to a verified clinic. Please describe your symptoms again so I can find the best match for you.',
            );
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

        // Text message — emergency check then intake
        // (text typed by tourist, no confirmation step needed)
        await this.runEmergencyCheckAndIntake(from, text, session);
    }

    // ─── Button reply handler ────────────────────────────────────

    private async handleButtonReply(
        from: string,
        buttonId: string,
        buttonLabel: string,
        session: WaSession,
    ): Promise<void> {

        switch (session.step) {

            // Voice transcript confirmation
            case 'AWAITING_SYMPTOM_CONFIRM':
                if (buttonId === 'confirm_yes') {
                    // symptomText already saved in handleAudioMessage
                    await this.runEmergencyCheckAndIntake(from, session.symptomText, session);
                } else {
                    // Tourist says transcript is wrong — ask them to type
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

            case 'AWAITING_Q5':
                session.intakeAnswers.q5 = this.intakeService.getLabelForAnswer(buttonId);
                session.step = 'AWAITING_TRIAGE';
                await this.sessionService.saveSession(session);
                await this.runFinalTriage(from, session);
                break;

            default:
                console.warn(`[WhatsApp] Button reply in unexpected state: ${session.step}`);
                await this.whatsappSend.sendTextMessage(
                    from,
                    'Please describe your symptoms to get started.',
                );
                await this.sessionService.clearSession(from);
                break;
        }
    }

    // ─── Emergency check + intake start ─────────────────────────
    // Shared by both text messages and confirmed voice transcripts

    private async runEmergencyCheckAndIntake(
        from: string,
        text: string,
        session: WaSession,
    ): Promise<void> {
        const emergencyResult = await this.triageService.checkEmergency(text);
        console.log('[WhatsApp] Emergency check:', emergencyResult);

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

    // ─── Final triage after Q5 ───────────────────────────────────

    private async runFinalTriage(from: string, session: WaSession): Promise<void> {
        await this.whatsappSend.sendTextMessage(from, '🔍 Analysing your symptoms...');

        const result = await this.aiService.runEnrichedTriage(
            session.symptomText,
            session.intakeAnswers,
        );

        session.triageResult = result;
        console.log(`[WhatsApp] Triage result for ${from}:`, result);

        if (result.emergency_flag || result.care_layer === 4) {
            await this.sendLayer4Response(from);
            await this.sessionService.clearSession(from);
            return;
        }

        // Send assessment summary before routing
        await this.sendTriageSummary(from, result);

        if (result.care_layer === 1) {
            await this.handleLayer1(from, session);
            return;
        }

        if (result.care_layer === 2) {
            await this.whatsappSend.sendTextMessage(
                from,
                '🩺 A *video consultation* with a doctor is recommended.\n\n' +
                'This feature is coming soon. Reply *DOCTOR* to find a nearby clinic instead.',
            );
            session.step = 'IDLE';
            await this.sessionService.saveSession(session);
            return;
        }

        if (result.care_layer === 3) {
            // TODO Step 4 — clinic matching
            await this.whatsappSend.sendTextMessage(
                from,
                '🏥 Finding verified clinics near you...\n\n_(Clinic booking coming in next build)_',
            );
            session.step = 'CLINIC_SELECTION';
            await this.sessionService.saveSession(session);
            return;
        }
    }

    // ─── Triage summary card ─────────────────────────────────────

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
            `👨‍⚕️ *Speciality:* ${result.speciality_needed}\n` +
            `⚠️ *Severity:* ${result.severity}`;

        await this.whatsappSend.sendTextMessage(from, message);
    }

    // ─── Layer 1 guidance ────────────────────────────────────────

    private async handleLayer1(from: string, session: WaSession): Promise<void> {
        const guidance = await this.aiService.getL1Guidance(
            session.symptomText,
            session.intakeAnswers,
            session.detectedLanguage,   // ← pass detected language
        );

        await this.whatsappSend.sendTextMessage(from, guidance + ESCALATION_FOOTER_EN);
        session.step = 'IDLE';
        await this.sessionService.saveSession(session);
    }

    // ─── Layer 4 response ────────────────────────────────────────

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

    // ─── Media helpers ───────────────────────────────────────────

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

    async sendTextMessage(to: string, body: string) {
        return this.whatsappSend.sendTextMessage(to, body);
    }

    async sendListMessage(to: string, text: string, sections: any[]) {
        return this.whatsappSend.sendListMessage(to, text, sections);
    }
}