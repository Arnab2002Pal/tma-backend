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
                        action: { button: 'Select', sections },
                    },
                },
                { headers: { Authorization: `Bearer ${this.token}` } },
            ),
        );
    }
}