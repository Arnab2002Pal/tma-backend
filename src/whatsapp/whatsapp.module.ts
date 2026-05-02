import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { TriageModule } from 'src/triage/triage.module';
import { WhatsappSendService } from './whatsapp-send.service';
import { WhatsappSendModule } from './whatsapp-send.module';
import { ClinicModule } from 'src/client/clinic.module';
import { BookingModule } from 'src/booking/booking.module';
import { WhatsappQrHandler } from './whatsapp-qr.handler';

@Module({
    imports: [HttpModule, TriageModule, WhatsappSendModule, ClinicModule, BookingModule],
    controllers: [WhatsappController],
    providers: [WhatsappService, WhatsappSendService, WhatsappQrHandler],
})
export class WhatsappModule { }
