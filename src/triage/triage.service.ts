import { Injectable } from '@nestjs/common';
import { AiService } from './ai.service';
import { BODY_STATE_KEYWORDS } from 'src/types/emergency.keywords';
import { EmergencyCheckUncertainError } from './triage.errors';

export type EmergencyCheckResult =
    | { isEmergency: true; reason: 'BODY_STATE_KEYWORD' | 'SYMPTOM_CONFIRMED_BY_AI' }
    | { isEmergency: false; reason: 'UNCERTAIN' | 'NO_MATCH' };

@Injectable()
export class TriageService {
    constructor(private readonly aiService: AiService) { }

    async checkEmergency(text: string): Promise<EmergencyCheckResult> {
        const lower = text.toLowerCase();

        // Stage 1 — Body state: direct Layer 4, no AI, zero ambiguity
        const bodyStateMatch = BODY_STATE_KEYWORDS.some((kw) => lower.includes(kw));
        if (bodyStateMatch) {
            console.log('[Triage] Body-state keyword matched → Layer 4 direct');
            return { isEmergency: true, reason: 'BODY_STATE_KEYWORD' };
        }

        // Stage 2 — Everything else goes to Haiku for context-aware check
        console.log('[Triage] No body-state keyword → Haiku context check');
        try {
            const isGenuineEmergency = await this.aiService.isEmergencyContext(text);
            if (isGenuineEmergency) {
                return { isEmergency: true, reason: 'SYMPTOM_CONFIRMED_BY_AI' };
            }
            return { isEmergency: false, reason: 'NO_MATCH' };
        } catch (error) {
            if (error instanceof EmergencyCheckUncertainError) {
                return { isEmergency: false, reason: 'UNCERTAIN' };
            }
            throw error;
        }
    }
}