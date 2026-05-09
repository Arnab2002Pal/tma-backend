import { Module } from '@nestjs/common';
import { TriageService } from './triage.service';
import { AiService } from './ai.service';
import { IntakeService } from './intake.service';
import { WhatsappSendModule } from '../whatsapp/whatsapp-send.module';

@Module({
  imports: [WhatsappSendModule],
  providers: [TriageService, AiService, IntakeService],
  exports: [TriageService, AiService, IntakeService],
})
export class TriageModule {}
