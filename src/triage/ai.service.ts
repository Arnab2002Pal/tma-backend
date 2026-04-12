import Anthropic from "@anthropic-ai/sdk";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI, { toFile } from "openai";
import { EmergencyCheckUncertainError } from "./triage.errors";

@Injectable()
export class AiService {
    private readonly openAi: OpenAI;
    private readonly anthropic: Anthropic;

    constructor(private config: ConfigService) {
        this.openAi = new OpenAI({
            apiKey: this.config.get<string>('OPENAI_API_KEY'),
        });
        this.anthropic = new Anthropic({
            apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
        });
    }

    // ─── Whisper Transcription ──────────────────────────────────
    async transcribe(audiobuffer: Buffer, name: string): Promise<string> {
        try {
            const file = await toFile(audiobuffer, name, { type: 'audio/ogg' })
            // const transcription = await this.openAi.audio.transcriptions.create({
            //     file: file,
            //     model: 'whisper-1',
            //     language: 'en',
            //     prompt: 'Medical triage for a tourist in India. Translate to English if not in English.',
            // })
            // return transcription.text;
            const translation = await this.openAi.audio.translations.create({
                file: file,
                model: 'whisper-1',
                // language: 'en',
                prompt: 'Medical triage for a tourist in India. Translate to English if not in English.',
            })
            return translation.text;
        } catch (error) {
            console.error('[AiService] Translation error:', error);
            throw new Error('Failed to process voice message');
        }
    }

    // ─── Haiku Emergency Context Check ─────────────────────────
    // Only called when a symptom keyword matched (not body-state keywords)
    // Returns true if genuine emergency, false if contextual/mild
    async isEmergencyContext(symptomText: string): Promise<boolean> {
        const prompt = `A tourist sent this message: "${symptomText}"
        It contains a potentially serious medical term. Determine if this is a genuine emergency requiring immediate emergency services (112).

        Emergency = true if: person is in immediate danger RIGHT NOW.
        Emergency = false if: symptom is mild, historical, after physical activity, context-qualified, or a general question.

        Examples:
        "chest pain after climbing mountain for 2 hours" → false
        "I have had chest pain since yesterday, mild" → false  
        "sudden chest pain right now cant breathe" → true
        "difficulty breathing after running" → false
        "I cannot breathe, throat is closing" → true

        Do not wrap the JSON in markdown code fences.
        Return ONLY valid JSON. No explanation. No markdown.
        {"emergency": true} or {"emergency": false}`;

        try {
            const response = await this.anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 20,
                temperature: 0.1,
                messages: [{ role: 'user', content: prompt }],
            });

            console.log('[AiService] Haiku response:', response);
            const raw = response.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('');

            // Strip markdown fences if Haiku returns them
            const clean = raw.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();

            console.log('[AiService] Haiku cleaned content:', clean);

            const parsed = JSON.parse(clean);
            return parsed.emergency === true;
        } catch (error) {
            console.error('[AiService] Emergency context check failed:', error);
            // We cannot determine severity — tell the tourist honestly
            throw new EmergencyCheckUncertainError();
        }
    }

}