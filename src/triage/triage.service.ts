// triage.service.ts
import { Injectable } from '@nestjs/common';
import { AiService } from './ai.service';
import { EmergencyCheckUncertainError } from './triage.errors';
import { BODY_STATE_KEYWORDS } from '../types/emergency.keywords';

export type EmergencyCheckResult =
    | { isEmergency: true; reason: 'BODY_STATE_KEYWORD' | 'SYMPTOM_CONFIRMED_BY_AI' }
    | { isEmergency: false; reason: 'UNCERTAIN' | 'NO_MATCH' };

@Injectable()
export class TriageService {
    constructor(private readonly aiService: AiService) { }

    async checkEmergency(text: string): Promise<EmergencyCheckResult> {
        const lower = text.toLowerCase();

        // Stage 1 — Body state keyword: direct Layer 4, no AI
        const bodyStateMatch = BODY_STATE_KEYWORDS.some((kw) => lower.includes(kw));
        if (bodyStateMatch) {
            console.log('[Triage] Body-state keyword matched → Layer 4 direct');
            return { isEmergency: true, reason: 'BODY_STATE_KEYWORD' };
        }

        // ── Circuit breaker gate ─────────────────────────────────────────────────
        // If Anthropic is down, skip AI check entirely — safe default is NO_MATCH → L3.
        // Never blocks a tourist; body-state keywords (Stage 1) still catch hard emergencies.
        if (this.aiService.isCircuitOpen()) {
            console.warn('[Triage] Circuit open — skipping Haiku emergency check, defaulting NO_MATCH');
            return { isEmergency: false, reason: 'NO_MATCH' };
        }

        // Stage 2 — Haiku context-aware check
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