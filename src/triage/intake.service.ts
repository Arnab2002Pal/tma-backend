// IntakeService.ts
import { Injectable } from '@nestjs/common';
import { WhatsappSendService } from '../whatsapp/whatsapp-send.service';

// Button option shape
interface ButtonOption {
    id: string;
    title: string; // max 20 chars — WhatsApp hard limit
}

@Injectable()
export class IntakeService {
    constructor(private readonly whatsappSend: WhatsappSendService) { }

    async sendQ1(to: string): Promise<void> {
        await this.whatsappSend.sendButtonMessage(
            to,
            '📋 *Quick check — 5 questions to find the right help for you.*\n\n*How bad are your symptoms right now?*',
            [
                { id: 'q1_mild', title: 'Mild — manageable' },
                { id: 'q1_moderate', title: 'Moderate — painful' },
                { id: 'q1_severe', title: 'Severe — very bad' },
            ],
        );
    }

    async sendQ2(to: string): Promise<void> {
        await this.whatsappSend.sendButtonMessage(
            to,
            '*Are your symptoms getting better or worse?*',
            [
                { id: 'q2_better', title: 'Getting better' },
                { id: 'q2_same', title: 'Staying the same' },
                { id: 'q2_worse', title: 'Getting worse' },
            ],
        );
    }

    async sendQ3(to: string): Promise<void> {
        await this.whatsappSend.sendButtonMessage(
            to,
            '*How long have you had these symptoms?*',
            [
                { id: 'q3_under1hr', title: 'Just started (<1hr)' },
                { id: 'q3_fewhours', title: 'A few hours' },
                { id: 'q3_yesterday', title: 'Since yesterday+' },
            ],
        );
    }

    async sendQ4(to: string): Promise<void> {
        await this.whatsappSend.sendButtonMessage(
            to,
            '*Are you able to move around normally?*',
            [
                { id: 'q4_fine', title: 'Yes, moving fine' },
                { id: 'q4_difficulty', title: 'With some difficulty' },
                { id: 'q4_resting', title: 'Mostly resting' },
            ],
        );
    }

    async sendQ5(to: string): Promise<void> {
        await this.whatsappSend.sendTextMessage(
            to,
            '*Any of these alongside your main symptom?*\n\n' +
            '1 — Nausea or vomiting\n' +
            '2 — Fever or chills\n' +
            '3 — Shortness of breath\n' +
            '4 — None of the above\n\n' +
            '_Reply with one or more numbers separated by commas_\n' +
            '_Example: *1, 3* or just *4* if none apply_',
        );
    }

    /**
     * Parses a multi-select Q5 reply.
     *
     * Valid inputs:   "1", "2,3", "1, 2, 3", "1,3"
     * Invalid inputs: "5", "1,5", "abc", ""
     *
     * Rules:
     *   - At least one valid number (1–4)
     *   - If 4 (none) is selected alongside others → treat as "None of the above" only
     *     (tourist may have selected 4 by mistake alongside real symptoms)
     *   - Returns null if input is entirely invalid
     */
    parseQ5Answer(raw: string): string | null {
        const VALID = new Set(['1', '2', '3', '4']);

        const parts = raw
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        if (parts.length === 0) return null;

        // Check all parts are valid numbers
        if (parts.some(p => !VALID.has(p))) return null;

        // Deduplicate
        const unique = [...new Set(parts)];

        // If "4 — None of the above" is mixed with real symptoms, discard 4
        // Tourist likely tapped multiple by mistake
        if (unique.includes('4') && unique.length > 1) {
            unique.splice(unique.indexOf('4'), 1);
        }

        const labelMap: Record<string, string> = {
            '1': 'Nausea or vomiting',
            '2': 'Fever or chills',
            '3': 'Shortness of breath',
            '4': 'None of the above',
        };

        return unique.map(n => labelMap[n]).join(', ');
    }

    // Human-readable label from button ID — used when feeding answers to Haiku
    getLabelForAnswer(buttonId: string): string {
        const labels: Record<string, string> = {
            // Q1–Q4 button IDs (unchanged)
            q1_mild: 'Mild — manageable',
            q1_moderate: 'Moderate — uncomfortable',
            q1_severe: 'Severe — very painful',
            q2_better: 'Getting better',
            q2_same: 'Staying the same',
            q2_worse: 'Getting worse',
            q3_under1hr: 'Just started (under 1 hour)',
            q3_fewhours: 'A few hours',
            q3_yesterday: 'Since yesterday or longer',
            q4_fine: 'Moving around normally',
            q4_difficulty: 'Moving with some difficulty',
            q4_resting: 'Mostly resting, limited movement',
            // Q5 number responses
            '1': 'Nausea or vomiting',
            '2': 'Fever or chills',
            '3': 'Shortness of breath',
            '4': 'None of the above',
        };
        return labels[buttonId] ?? buttonId;
    }
}