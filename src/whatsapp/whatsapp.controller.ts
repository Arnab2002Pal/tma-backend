import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { ConfigService } from '@nestjs/config';
import { AiService } from 'src/triage/ai.service';

@Controller('whatsapp')
export class WhatsappController {
    constructor(
        private readonly whatsappService: WhatsappService,
        private readonly config: ConfigService,
        private readonly aiService: AiService
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
            const mediaUrl = await this.whatsappService.getMediaUrl(message.audio.id);
            const audioBuffer = await this.whatsappService.downloadMedia(mediaUrl);

            console.log(`Received audio from ${from}, media URL: ${mediaUrl}`);
            console.log(`audioBuffer: ${audioBuffer.length} bytes`);
            const transcript = await this.aiService.transcribe(audioBuffer, 'voice.ogg');

            console.log("transcript:---:", transcript);
            
            // const result = await this.triageService.processInput(transcript, from);
            // await this.whatsappService.sendTextMessage(from, result.message);
        }

        return { status: 'success' };
    }
}