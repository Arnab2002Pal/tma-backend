import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsappSendService } from './whatsapp-send.service';

@Module({
    imports: [HttpModule],
    providers: [WhatsappSendService],
    exports: [WhatsappSendService],
})
export class WhatsappSendModule { }