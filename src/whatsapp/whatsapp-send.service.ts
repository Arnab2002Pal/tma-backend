import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

interface ButtonOption {
    id: string;
    title: string;
}

@Injectable()
export class WhatsappSendService {
    private readonly baseUrl: string;
    private readonly token: string;

    constructor(
        private readonly httpService: HttpService,
        private readonly config: ConfigService,
    ) {
        this.baseUrl = `https://graph.facebook.com/v21.0/${this.config.get('WHATSAPP_PHONE_NUMBER_ID')!}`;
        this.token = this.config.get('WHATSAPP_ACCESS_TOKEN')!;
    }

    async sendTextMessage(to: string, body: string): Promise<void> {
        await firstValueFrom(
            this.httpService.post(
                `${this.baseUrl}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to,
                    type: 'text',
                    text: { body },
                },
                { headers: { Authorization: `Bearer ${this.token}` } },
            ),
        );
    }

    async sendButtonMessage(to: string, bodyText: string, buttons: ButtonOption[]): Promise<void> {
        await firstValueFrom(
            this.httpService.post(
                `${this.baseUrl}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to,
                    type: 'interactive',
                    interactive: {
                        type: 'button',
                        body: { text: bodyText },
                        action: {
                            buttons: buttons.map((b) => ({
                                type: 'reply',
                                reply: { id: b.id, title: b.title },
                            })),
                        },
                    },
                },
                { headers: { Authorization: `Bearer ${this.token}` } },
            ),
        );
    }

    async sendListMessage(to: string, bodyText: string, sections: any[]): Promise<void> {
        // WhatsApp List Message API hard limits — enforced here so no call site can forget:
        // row title: 24 chars max | row description: 72 chars max | section title: 24 chars max
        const sanitizedSections = sections.map((section) => ({
            ...section,
            ...(section.title && {
                title: this.truncate(section.title, 24),
            }),
            rows: (section.rows ?? []).map((row: any) => ({
                ...row,
                title: this.truncate(row.title, 24),
                ...(row.description && {
                    description: this.truncate(row.description, 72),
                }),
            })),
        }));

        await firstValueFrom(
            this.httpService.post(
                `${this.baseUrl}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to,
                    type: 'interactive',
                    interactive: {
                        type: 'list',
                        body: { text: bodyText },
                        action: { button: 'Select', sections: sanitizedSections },
                    },
                },
                { headers: { Authorization: `Bearer ${this.token}` } },
            ),
        );
    }

    // Truncates to maxLen, appending '…' (single char, U+2026) so the cut is obvious.
    // 1-char ellipsis wastes as little of the limit as possible vs '...' (3 chars).
    private truncate(text: string, maxLen: number): string {
        if (text.length <= maxLen) return text;
        return text.slice(0, maxLen - 1) + '…';
    }
}