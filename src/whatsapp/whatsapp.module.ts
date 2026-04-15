import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { TriageModule } from 'src/triage/triage.module';
import { WhatsappSendService } from './whatsapp-send.service';
import { WhatsappSendModule } from './whatsapp-send.module';

@Module({
    imports: [HttpModule, TriageModule, WhatsappSendModule],
    controllers: [WhatsappController],
    providers: [WhatsappService, WhatsappSendService],
})
export class WhatsappModule { }
