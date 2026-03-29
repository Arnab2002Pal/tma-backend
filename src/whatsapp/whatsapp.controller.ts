import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { ConfigService } from '@nestjs/config';

@Controller('whatsapp')
export class WhatsappController {
    constructor(
        private readonly whatsappService: WhatsappService,
        private readonly config: ConfigService,
    ) { }

    // 1. Webhook Verification (GET)
    @Get('webhook')
    verifyWebhook(
        @Query('hub.mode') mode: string,
        @Query('hub.verify_token') token: string,
        @Query('hub.challenge') challenge: string,
    ) {
        const verifyToken = this.config.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
        if (mode === 'subscribe' && token === verifyToken) {
            return challenge;
        }
        return 'Forbidden';
    }

    // 2. Message Handler (POST)
    @Post('webhook')
    @HttpCode(HttpStatus.OK)
    async handleIncoming(@Body() body: any) {
        // Check if it's a message event
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const message = changes?.value?.messages?.[0];

        if (!message) return { status: 'ignored' };

        const from = message.from; // Tourist's WhatsApp ID
        const messageType = message.type;

        if (messageType === 'text') {
            const text = message.text.body;
            console.log(`Received text: ${text} from ${from}`);
            // TODO: Pass 'text' to Emergency Filter -> Triage Service
        }

        if (messageType === 'audio') {
            const audioId = message.audio.id;
            console.log(`Received audio ID: ${audioId}`);
            // TODO: Download from Meta -> OpenAI Whisper
        }

        return { status: 'success' };
    }
}