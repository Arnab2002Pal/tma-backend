// Whatsapp.controller.ts
import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { ConfigService } from '@nestjs/config';
import { WhatsappSendService } from './whatsapp-send.service';
import { RedisService } from '../session/redis.service';

@Controller('whatsapp')
export class WhatsappController {
    constructor(
        private readonly whatsappService: WhatsappService,
        private readonly config: ConfigService,
        private readonly whatsappSend: WhatsappSendService,
        private readonly sessionService: RedisService,
    ) { }

    @Get('webhook')
    verifyWebhook(
        @Query('hub.mode') mode: string,
        @Query('hub.verify_token') token: string,
        @Query('hub.challenge') challenge: string,
    ) {
        const verifyToken = this.config.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
        if (mode === 'subscribe' && token === verifyToken) return challenge;
        return 'Forbidden';
    }

    @Post('webhook')
    @HttpCode(HttpStatus.OK)
    async handleIncoming(@Body() body: any) {
        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) return { status: 'ignored' };

        const wamid: string | undefined = message.id;
        
        // In handleIncoming(), after extracting message:
        if (wamid && await this.sessionService.isDuplicate(wamid)) {
            return { status: 'duplicate' };
        }

        if (wamid) {
            this.whatsappSend.markAsRead(wamid).catch(() => {}); // fire-and-forget, already silent
        }

        // Return 200 immediately — process async
        setImmediate(() => this.whatsappService.processMessage(message));
        return { status: 'ok' };
    }
}