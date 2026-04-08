// src/modules/triage/triage.service.ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class TriageService {
    private readonly emergencyKeywords = ['chest pain', 'breathing', 'unconscious', 'bleeding'];

    async processInput(text: string, userId: string) {
        // 1. Layer 4: Hardcoded Emergency Check
        if (this.isEmergency(text)) {
            return {
                layer: 4,
                message: "EMERGENCY: Please call 112 immediately. The nearest ER is located at..."
            };
        }

        // 2. Layer 1-3: Call Claude Haiku for Triage
        // TODO: Implement Anthropic API call
        return { layer: 1, message: "Analyzing your symptoms..." };
    }

    private isEmergency(text: string): boolean {
        const lowerText = text.toLowerCase();
        return this.emergencyKeywords.some(key => lowerText.includes(key));
    }
}