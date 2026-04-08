import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WhatsappService {
    private readonly baseUrl: string;
    private readonly token: string;

    constructor(
        private readonly httpService: HttpService,
        private readonly config: ConfigService,
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
}