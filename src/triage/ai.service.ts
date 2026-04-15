import Anthropic from "@anthropic-ai/sdk";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI, { toFile } from "openai";
import { EmergencyCheckUncertainError } from "./triage.errors";
import { IntakeAnswers, TriageResult } from "src/types/session.types";

export interface TranscribeResult {
    text: string;
    language: string; // ISO 639-1 code: 'en', 'hi', 'bn', 'fr', 'de' etc.
}

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

    // ─── Whisper: detect language + translate to English ────────
    async transcribe(audioBuffer: Buffer, name: string): Promise<TranscribeResult> {
        const medicalPrompt = 'Medical symptoms described by a tourist. Translate accurately to English.';

        try {
            const file1 = await toFile(audioBuffer, name, { type: 'audio/ogg' });
            const file2 = await toFile(audioBuffer, name, { type: 'audio/ogg' });

            // Call 1 — detect dominant language via verbose_json transcription
            const transcription = await this.openAi.audio.transcriptions.create({
                file: file1,
                model: 'whisper-1',
                response_format: 'verbose_json',
            }) as any; // verbose_json includes language field not in base type
            const detectedLanguage: string = transcription.language ?? 'en';

            // Call 2 — translate to English regardless of source language
            const translation = await this.openAi.audio.translations.create({
                file: file2,
                model: 'whisper-1',
                prompt: medicalPrompt,
            });

            const text = translation.text?.trim() ?? '';
            console.log(`[AiService] Whisper detected language: ${detectedLanguage}, translated: "${text}"`);

            return { text, language: detectedLanguage };
        } catch (error) {
            console.error('[AiService] Transcription error:', error);
            throw new Error('Failed to process voice message');
        }
    }

    // ─── Gibberish detection ────────────────────────────────────
    isLikelyGibberish(text: string): boolean {
        const words = text.trim().split(/\s+/);

        // Too short to be a real symptom description
        if (words.length < 3) return true;

        // High word repetition — common Whisper hallucination pattern
        const unique = new Set(words.map(w => w.toLowerCase()));
        if (words.length > 8 && unique.size / words.length < 0.4) return true;

        return false;
    }

    // ─── Haiku Emergency Context Check ─────────────────────────
    async isEmergencyContext(symptomText: string): Promise<boolean> {
        const prompt = `A tourist sent this message: "${symptomText}"
        Determine if this is a genuine emergency requiring immediate emergency services (112).

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

            const raw = response.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('');

            const clean = raw.trim()
                .replace(/^```json\s*/i, '')
                .replace(/```$/, '')
                .trim();

            console.log('[AiService] Haiku cleaned content:', clean);
            const parsed = JSON.parse(clean);
            return parsed.emergency === true;
        } catch (error) {
            console.error('[AiService] Emergency context check failed:', error);
            throw new EmergencyCheckUncertainError();
        }
    }

    // ─── Haiku Enriched Triage (post MCQ) ──────────────────────
    async runEnrichedTriage(
        symptomText: string,
        intakeAnswers: IntakeAnswers,
    ): Promise<TriageResult> {
        const prompt = `
        You are a medical triage assistant for tourists visiting India. 
        Your goal is to map the user to the correct "Care Layer" based on safety and medical necessity.

        Tourist's symptom description: "${symptomText}"

        Intake answers:
        - Severity: ${intakeAnswers.q1 ?? 'not provided'}
        - Trajectory: ${intakeAnswers.q2 ?? 'not provided'}
        - Duration: ${intakeAnswers.q3 ?? 'not provided'}
        - Functional impact: ${intakeAnswers.q4 ?? 'not provided'}
        - Associated symptoms: ${intakeAnswers.q5 ?? 'not provided'}

        CARE LAYER DEFINITIONS:
        - Layer 1 (AI Self-Care): Mild symptoms, no "red flags," low functional impact. Benefit: Immediate relief via home remedies.
        - Layer 2 (Telemedicine): Moderate symptoms requiring professional talk but no physical exam (e.g., prescriptions, mild infections). Benefit: Remote expert advice.
        - Layer 3 (OPD/Clinic): Requires physical examination, diagnostic tests, or localized treatment. Benefit: In-person verified clinical care.
        - Layer 4 (Emergency): Life-threatening, severe trauma, or rapid deterioration. Benefit: Immediate life-saving intervention.

        Based on ALL of the above, classify and return ONLY valid JSON. No markdown. No code fences. No explanation.

        {
        "severity": "mild" | "moderate" | "serious" | "emergency",
        "care_layer": 1 | 2 | 3 | 4,
        "summary": "One sentence, plain English, max 12 words",
        "speciality_needed": "general physician" | "dermatologist" | "orthopaedic" | "dentist" | "ophthalmologist" | "gynaecologist" | "ent specialist" | "cardiologist" | "gastroenterologist",
        "ai_guidance": "2-3 self-care steps in plain English — ONLY if care_layer is 1, otherwise empty string",
        "emergency_flag": true | false
        }

        Rules:
        1. IF emergency_flag is true OR severity is "emergency" → care_layer MUST be 4.
        2. IF symptoms are moderate but require a physical check (e.g. ear pain, deep cut, lung sounds) → care_layer 3.
        3. IF symptoms are moderate but can be diagnosed via conversation (e.g. simple rash, mild UTI) → care_layer 2.
        4. IF symptoms are mild (e.g. slight indigestion, minor scratch) → care_layer 1.
        5. Vague or unclear answers → default care_layer 3.
        6. Never suggest specific medicines, drug names, or dosages.
        7. All fields required, no extras, no markdown.
        `.trim();

        try {
            const response = await this.anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                temperature: 0.1,
                messages: [{ role: 'user', content: prompt }],
            });

            const raw = response.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('');

            const clean = raw.trim()
                .replace(/^```json\s*/i, '')
                .replace(/```$/, '')
                .trim();

            console.log('[AiService] Enriched triage result:', clean);
            const parsed = JSON.parse(clean);
            return parsed as TriageResult;
        } catch (error) {
            console.error('[AiService] Enriched triage failed, defaulting to L3:', error);
            return {
                severity: 'moderate',
                care_layer: 3,
                summary: 'Unable to classify symptoms accurately',
                speciality_needed: 'general physician',
                ai_guidance: '',
                emergency_flag: false,
            };
        }
    }

    // ─── Sonnet L1 Guidance ─────────────────────────────────────
    async getL1Guidance(
        symptomText: string,
        intakeAnswers: IntakeAnswers,
        language: string = 'en',
    ): Promise<string> {
        // Map ISO 639-1 to language name for Sonnet instruction
        const languageNames: Record<string, string> = {
            en: 'English', hi: 'Hindi', bn: 'Bengali',
            fr: 'French', de: 'German', es: 'Spanish',
            ja: 'Japanese', zh: 'Chinese', ar: 'Arabic',
            ru: 'Russian', pt: 'Portuguese', ko: 'Korean',
        };
        const languageName = languageNames[language] ?? 'English';

        const systemPrompt = `You are a compassionate medical guidance assistant for tourists who are experiencing mild symptoms. You provide comfort-focused self-care advice only.

        STRICT RULES — NEVER VIOLATE:
        1. Never name specific medicines, brands, or drug molecules
        2. Never give dosage instructions of any kind
        3. Never suggest anything requiring a prescription
        4. Never diagnose a condition by name
        5. Keep response to 3-4 short steps maximum
        6. Warm, calm tone — tourist is already anxious

        WHAT YOU CAN SUGGEST:
        - Rest and sleep
        - Hydration (plain water, coconut water, clear fluids)
        - Light easily digestible food (plain rice, toast, banana)
        - Positioning (elevate legs, sit upright, lie on left side)
        - Temperature management (cool wet cloth on forehead, warm compress on stomach)
        - Breathing techniques for anxiety or mild breathlessness
        - ONE generic OTC category if genuinely needed — phrased as "a simple painkiller available at any pharmacy" — never a name

        CONTEXT: Tourist is away from home in an unfamiliar city. Assume minimal resources. Hotel room only.`;

                const userPrompt = `Tourist symptom: "${symptomText}"
        Severity: ${intakeAnswers.q1 ?? 'mild'}
        Trajectory: ${intakeAnswers.q2 ?? 'staying same'}
        Duration: ${intakeAnswers.q3 ?? 'few hours'}
        Functional impact: ${intakeAnswers.q4 ?? 'moving fine'}
        Associated symptoms: ${intakeAnswers.q5 ?? 'none'}

        Respond in ${languageName}.`;

        try {
            const response = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-5',
                max_tokens: 1000,
                temperature: 0.7,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
            });

            return response.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('')
                .trim();
        } catch (error) {
            console.error('[AiService] L1 guidance failed:', error);
            return 'Please rest, stay hydrated, and monitor your symptoms. Drink plenty of water and avoid exertion.';
        }
    }
}