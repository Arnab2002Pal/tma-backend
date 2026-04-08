import { Module } from '@nestjs/common';
import { TriageService } from './triage.service';
import { AiService } from './ai.service';

@Module({
  providers: [TriageService, AiService],
  exports: [AiService]
})
export class TriageModule {}
