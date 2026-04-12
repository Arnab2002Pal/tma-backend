import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AiService } from 'src/triage/ai.service';
import { TriageService } from 'src/triage/triage.service';

@Injectable()
export class WhatsappService {
    private readonly baseUrl: string;
    private readonly token: string;

    constructor(
        private readonly httpService: HttpService,
        private readonly config: ConfigService,
        private readonly aiService: AiService,
        private readonly triageService: TriageService,
    ) {
        this.baseUrl = `https://graph.facebook.com/v21.0/${this.config.get('WHATSAPP_PHONE_NUMBER_ID')!}`;
        this.token = this.config.get('WHATSAPP_ACCESS_TOKEN')!;
    }

    // Send Text Message (Layer 1 Advice)
    async sendTextMessage(to: string, body: string) {
        const url = `${this.baseUrl}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body },
        };
        return firstValueFrom(this.httpService.post(url, data, {
            headers: { Authorization: `Bearer ${this.token}` },
        }));
    }

    // Send MCQ (List Message for Layer 3 Clinic Selection)
    async sendListMessage(to: string, text: string, sections: any[]) {
        const url = `${this.baseUrl}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'list',
                body: { text },
                action: {
                    button: 'Select Clinic',
                    sections,
                },
            },
        };
        return firstValueFrom(this.httpService.post(url, data, {
            headers: { Authorization: `Bearer ${this.token}` },
        }));
    }

    async getMediaUrl(mediaId: string): Promise<string> {
        const url = `https://graph.facebook.com/v21.0/${mediaId}`;
        const response = await firstValueFrom(
            this.httpService.get(url, {
                headers: { Authorization: `Bearer ${this.token}` },
            }),
        );
        return response.data.url; // This is the temporary download link
    }

    async downloadMedia(url: string): Promise<Buffer> {
        const response = await firstValueFrom(
            this.httpService.get(url, {
                headers: { Authorization: `Bearer ${this.token}` },
                responseType: 'arraybuffer', // Crucial for binary data
            }),
        );
        return Buffer.from(response.data);
    }

    async processMessage(message: any): Promise<void> {
        const from = message.from;
        const messageType = message.type;
        console.log('Message from:', from);

        try {
            let text: string | null = null;

            // ── Resolve text from message type ──
            if (messageType === 'text') {
                text = message.text.body;
            } else if (messageType === 'audio') {
                const mediaUrl = await this.getMediaUrl(message.audio.id);
                const audioBuffer = await this.downloadMedia(mediaUrl);
                text = await this.aiService.transcribe(audioBuffer, 'voice.ogg');
            } else if (messageType === 'interactive') {
                // Button replies handled in Step 3
                console.log('[WhatsApp] Interactive message received — handled in Step 3');
                return;
            } else {
                // status updates, reactions etc — ignore silently
                return;
            }

            if (!text?.trim()) return;

            console.log(`[WhatsApp] Resolved text from ${from}: "${text}"`);

            // ── Emergency pre-screen (runs on every message) ──
            const emergencyResult = await this.triageService.checkEmergency(text);
            console.log('[Whatsapp] Emergency check result:', emergencyResult);
            
            if (emergencyResult.isEmergency) {
                console.log('[WhatsApp] Emergency is true.');
                
                await this.sendLayer4Response(from);
                return;
            }

            if (emergencyResult.reason === 'UNCERTAIN') {
                console.log('[WhatsApp] Emergency is uncertain.');

                await this.sendTextMessage(from,
                    '⚠️ I want to make sure you get the right help.\n\n' +
                    'Are you experiencing a *life-threatening emergency right now?*\n\n' +
                    'Reply *YES* to get emergency contacts immediately\n' +
                    'Reply *NO* to continue with your symptoms'
                );
                // TODO: set session step to AWAITING_EMERGENCY_CONFIRM
                return;
            }

            // reason === 'NO_MATCH' — safe to proceed
            console.log(`[WhatsApp] No emergency detected for ${from} → proceed to intake`);
            // TODO: Step 3 — session load + MCQ flow


        } catch (error) {
            console.error(`[WhatsApp] processMessage error for ${from}:`, error);
            await this.sendTextMessage(from,
                'Sorry, something went wrong. Please try again or call 112 if this is an emergency.'
            );
        }
    }

    private async sendLayer4Response(to: string): Promise<void> {
        await this.sendTextMessage(
            to,
            '🚨 *EMERGENCY DETECTED*\n\n' +
            'Please call *112* immediately.\n\n' +
            'Nearest 24-hour emergency hospitals:\n' +
            '_Stay on the line with 112. Help is on the way._'
        );
    }
}