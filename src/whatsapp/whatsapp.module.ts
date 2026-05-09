import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappSendService } from './whatsapp-send.service';
import { WhatsappSendModule } from './whatsapp-send.module';
import { WhatsappQrHandler } from './whatsapp-qr.handler';
import { TriageModule } from '../triage/triage.module';
import { ClinicModule } from '../client/clinic.module';
import { BookingModule } from '../booking/booking.module';

@Module({
    imports: [HttpModule, TriageModule, WhatsappSendModule, ClinicModule, BookingModule],
    controllers: [WhatsappController],
    providers: [WhatsappService, WhatsappSendService, WhatsappQrHandler],
})
export class WhatsappModule { }
