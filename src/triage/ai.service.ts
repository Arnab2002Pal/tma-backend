/**
 * ============================================================
 * TMA — AI SERVICES REFERENCE
 * ============================================================
 *
 * 1. GOOGLE CLOUD SPEECH-TO-TEXT  (Chirp 2)
 *    Where  : AiService.transcribeWithGoogle()  → called by transcribe()
 *    Model  : chirp_2  via Speech-to-Text V2 API
 *    Region : asia-southeast1  (only GA region for Chirp 2 as of 2025)
 *    Why    : Whisper had poor local language accuracy — critical for Kolkata launch.
 *             Chirp 2 handles bn-IN, hi-IN, en-IN and 100+ others with a
 *             single language_codes:["auto"] config — no language hints needed.
 *             Built-in audio denoising handles noisy hotel-room voice notes.
 *    Cost   : ~$0.016/min. Typical WhatsApp voice note (30–60s) ≈ $0.016/msg.
 *
 * 2. OPENAI WHISPER  (whisper-1)
 *    Where  : AiService.transcribeWithWhisper()  → called by transcribe()
 *             only when Google STT throws
 *    Model  : whisper-1
 *    Why    : Fallback only. Kept because it auto-translates to English in
 *             a single translations API call — useful if Google STT is
 *             temporarily unavailable.
 *
 * 3. ANTHROPIC CLAUDE HAIKU  (claude-haiku-4-5-20251001)
 *    Used in three places:
 *
 *    a) Translation         — AiService.translateToEnglish()
 *       Called after Google STT when detectedLanguage !== 'en'.
 *       temperature: 0  — deterministic, no creative drift on medical text.
 *       Why Haiku: already in stack, handles medical context better than
 *       generic translation APIs (e.g. "মাথা ঘুরছে" → "I feel dizzy",
 *       not "head is spinning").
 *
 *    b) Emergency screening — AiService.isEmergencyContext()
 *       Runs on EVERY message, including mid-conversation.
 *       max_tokens: 20, temperature: 0 — forces {"emergency":true/false} only.
 *       Retries once on SyntaxError; throws EmergencyCheckUncertainError
 *       on second failure → YES/NO prompt to tourist. Never defaults silently.
 *       Why Haiku: sub-200ms latency matters here — this is the zero-latency
 *       safety gate before any other processing.
 *
 *    c) Enriched triage     — AiService.runEnrichedTriage()
 *       Runs after all 5 MCQ answers are collected.
 *       temperature: 0.1 — slight variance for nuanced classification.
 *       Returns structured JSON: severity, care_layer (1–4), speciality_needed.
 *       Why Haiku: cost-sensitive — this runs on every triage completion.
 *       L3 is the safe default on any parse failure.
 *
 * 4. ANTHROPIC CLAUDE SONNET  (claude-sonnet-4-5)
 *    Used in two places:
 *
 *    a) L1 Guidance         — AiService.getL1Guidance()
 *       Mild symptoms only (care_layer === 1). temperature: 0.7 — warm,
 *       human-feeling response. Responds in tourist's detected language.
 *       Hard constraints: no drug names, no brands, no dosages, no diagnosis.
 *       Escalation footer is HARDCODED by application code — never AI-generated.
 *
 *    b) L1 After-hours      — AiService.getL1GuidanceAfterHours()
 *       Same rules as above + hotel staff context injected into system prompt.
 *       Suggests asking reception for blankets/hot water/basic first aid.
 *       Never specifies what drug hotel staff should provide.
 *       Why Sonnet over Haiku: L1 guidance is the product — the tourist reads
 *       it directly. Quality and tone matter more than cost at this step.
 *
 * ============================================================
 * DECISION LOG
 * ============================================================
 *  - Self-hosted LLM rejected: not cost-effective below ~50K calls/day
 *  - Chirp 3 (preview) skipped: not GA for sync Recognize as of launch date
 *  - Google Translate API skipped: Haiku already in stack + better medical context
 *  - Whisper retained: zero-cost fallback, covers Google STT outages
 * ============================================================
 */
import Anthropic from "@anthropic-ai/sdk";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v2 } from '@google-cloud/speech';
import OpenAI, { toFile } from "openai";
import { EmergencyCheckUncertainError } from "./triage.errors";
import { IntakeAnswers, TriageResult } from "../types/session.types";

export interface TranscribeResult {
    text: string;
    language: string; // ISO 639-1 code: 'en', 'hi', 'bn', 'fr', etc.
}

// Google STT V2 Chirp 2 is available in these regions (GA as of 2025)
const GOOGLE_STT_REGION = "asia-southeast1"; // Singapore — closest to India, low latency, supports Chirp 2. Other options: us-central1, europe-west1, etc.
const GOOGLE_STT_MODEL = "chirp_2";

// Whisper is used as fallback only — if Google STT fails for any reason
const WHISPER_MODEL = "whisper-1";

// Haiku models for translation, emergency check, and enriched triage
const CLAUDE_HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CLAUSE_SONNET = "claude-sonnet-4-5";

@Injectable()
export class AiService {
    private readonly openAi: OpenAI;
    private readonly anthropic: Anthropic;
    private readonly googleStt: v2.SpeechClient;
    private readonly gcpProject: string;

    // ─── Circuit Breaker ─────────────────────────────────────────────────────────
    private cbFailures = 0;
    private cbOpenedAt: number | null = null;
    private readonly CB_THRESHOLD = 3;       // trips after 3 consecutive failures
    private readonly CB_RESET_MS  = 5 * 60 * 1000; // half-open after 5 min
    
    constructor(private config: ConfigService) {
        this.openAi = new OpenAI({
            apiKey: this.config.get<string>("OPENAI_API_KEY"),
        });
        this.anthropic = new Anthropic({
            apiKey: this.config.get<string>("ANTHROPIC_API_KEY"),
        });

        this.gcpProject = this.config.get<string>("GOOGLE_CLOUD_PROJECT") ?? "";
        
        if (!this.gcpProject) {
            console.warn("[AiService] GOOGLE_CLOUD_PROJECT is not set — Google STT will fail and fall back to Whisper");
        }
        // Google STT client — picks up GOOGLE_APPLICATION_CREDENTIALS from env automatically

        // Force gRPC stub to initialize eagerly at startup.
        // Without this, lazy init fires mid-request and throws an unhandled rejection
        // that escapes the try/catch in transcribeWithGoogle() — crashing Node 22.
        // Error is swallowed here intentionally — Whisper fallback handles runtime STT.
        this.googleStt = new v2.SpeechClient({
            apiEndpoint: `${GOOGLE_STT_REGION}-speech.googleapis.com`,
            // Explicitly pass empty credentials when GCP env vars are absent.
            // Prevents gRPC from attempting background ADC discovery that fires
            // an unhandled rejection mid-request when Whisper fallback is active.
            ...(this.gcpProject ? {} : { credentials: { client_email: '', private_key: '' } }),
        });
    }

    // ─── Circuit Breaker helpers ──────────────────────────────────────────────
    isCircuitOpen(): boolean {
        if (this.cbOpenedAt === null) return false;
        if (Date.now() - this.cbOpenedAt >= this.CB_RESET_MS) {
            // half-open: allow one probe through
            console.log('[AiService][CircuitBreaker] Half-open — allowing probe');
            this.cbOpenedAt = null;
            this.cbFailures = 0;
            return false;
        }
        return true;
    }

    private recordSuccess(): void {
        this.cbFailures = 0;
        this.cbOpenedAt = null;
        console.log('[AiService][CircuitBreaker] Success — circuit closed');
    }

    private recordFailure(): void {
        this.cbFailures++;
        console.warn(`[AiService][CircuitBreaker] Failure ${this.cbFailures}/${this.CB_THRESHOLD}`);
        if (this.cbFailures >= this.CB_THRESHOLD && this.cbOpenedAt === null) {
            this.cbOpenedAt = Date.now();
            console.error('[AiService][CircuitBreaker] OPEN — degrading to L3 until reset');
        }
    }

    // ─── Static after-hours guidance (AI outage / after-hours fallback) ───────
    // 5 symptom buckets matched by keyword. Reception contact always included.
    // Never names drugs or dosages — same rules as Sonnet L1 guidance.
    getStaticAfterHoursGuidance(symptomText: string): string {
        const t = symptomText.toLowerCase();

        if (/fever|temperature|chills|sweating/.test(t)) {
            return (
                '🌡️ For fever overnight:\n\n' +
                '1. Place a cool damp cloth on your forehead and wrists.\n' +
                '2. Drink water or any clear fluid steadily — small sips if nauseous.\n' +
                '3. Remove heavy blankets; light clothing helps your body cool.\n' +
                '4. Ask hotel reception for a basic first aid kit or something for fever.\n\n' +
                'Rest now. See a doctor when clinics open at 8am.'
            );
        }

        if (/stomach|nausea|vomit|diarrhea|diarrhoea|abdomen|cramp|indigestion/.test(t)) {
            return (
                '🪄 For stomach discomfort overnight:\n\n' +
                '1. Sip plain water or a clear fluid slowly — avoid large amounts at once.\n' +
                '2. Eat nothing heavy; plain toast, banana, or plain rice only if hungry.\n' +
                '3. Lie on your left side — this helps digestion and reduces nausea.\n' +
                '4. Ask hotel reception if they have a hot water bottle or basic first aid kit.\n\n' +
                'Rest now. If vomiting is severe or you see blood, call 112 immediately.'
            );
        }

        if (/headache|migraine|head pain|head is/.test(t)) {
            return (
                '🧠 For headache overnight:\n\n' +
                '1. Lie down in a dark, quiet room.\n' +
                '2. Drink a full glass of water — dehydration is a common cause.\n' +
                '3. Place a cool damp cloth on your forehead.\n' +
                '4. Ask hotel reception for a simple painkiller if available.\n\n' +
                'Rest now. If the headache is sudden and severe ("worst of your life"), call 112 immediately.'
            );
        }

        if (/cough|cold|throat|congestion|runny|sneezing|breathing|breath/.test(t)) {
            return (
                '🤧 For cold or breathing discomfort overnight:\n\n' +
                '1. Sit upright or prop yourself up with pillows — lying flat worsens congestion.\n' +
                '2. Breathe over a bowl of hot water (or in a steamy bathroom) for 5–10 minutes.\n' +
                '3. Sip warm water or herbal tea steadily.\n' +
                '4. Ask hotel reception for extra pillows or hot water.\n\n' +
                'Rest now. If you feel you cannot breathe properly, call 112 immediately.'
            );
        }

        if (/pain|hurt|injury|sprain|twist|cut|wound|bruise|swollen/.test(t)) {
            return (
                '🩹 For pain or minor injury overnight:\n\n' +
                '1. Rest the affected area — avoid putting weight on it.\n' +
                '2. If swollen, elevate it above heart level (e.g. prop your ankle on a pillow).\n' +
                '3. Apply a cool damp cloth to reduce swelling — 10 min on, 10 min off.\n' +
                '4. Ask hotel reception for a basic first aid kit or ice pack.\n\n' +
                'Rest now. See a doctor when clinics open at 8am.'
            );
        }

        // Default bucket
        return (
            '🏨 While clinics are closed:\n\n' +
            '1. Rest and avoid any exertion.\n' +
            '2. Drink plain water steadily.\n' +
            '3. Ask hotel reception if they have a basic first aid kit.\n\n' +
            'If symptoms become serious at any point, call *112* immediately.\n' +
            'Clinics open at 8am — reply *DOCTOR* then and I\'ll find one near you.'
        );
    }

    // ─── Primary: Google STT Chirp 2 ────────────────────────────
    // Returns transcribed text in original language + ISO 639-1 detected language code.
    // Uses language_codes: ["auto"] — Chirp 2 auto-detects from 100+ languages.
    // No language hints passed — universal, matches TMA invariant.
    private async transcribeWithGoogle(audioBuffer: Buffer): Promise<TranscribeResult> {
        console.log(`[AiService][Google STT] Starting transcription — model=${GOOGLE_STT_MODEL}, region=${GOOGLE_STT_REGION}, audioBytes=${audioBuffer.length}`);
        if (!this.gcpProject) {
            throw new Error('Google STT skipped — GOOGLE_CLOUD_PROJECT not set');
        }
        const recognizer = `projects/${this.gcpProject}/locations/${GOOGLE_STT_REGION}/recognizers/_`;
        
        const [response] = await (this.googleStt as any).recognize({
            recognizer,
            config: {
                model: GOOGLE_STT_MODEL,
                autoDecodingConfig: {},          // let Chirp 2 auto-detect encoding + sample rate
                languageCodes: ["auto"],          // universal language detection — no hints
                features: {
                    enableAutomaticPunctuation: true,
                },
            },
            content: audioBuffer,               // inline audio bytes (< 60s WhatsApp voice notes)
        });

        const results = response?.results ?? [];

        if (!results.length) {
            console.warn("[AiService][Google STT] No results returned from Chirp 2");
            throw new Error("Google STT returned no results");
        }

        // Pick the highest-confidence alternative from the first result
        const best = results[0]?.alternatives?.[0];
        const text = best?.transcript?.trim() ?? "";
        const confidence = best?.confidence ?? 0;

        // Detected language comes back as BCP-47 (e.g. "bn-IN", "hi-IN", "en-US")
        // Normalise to ISO 639-1 (e.g. "bn", "hi", "en") for downstream compatibility
        const bcp47Lang: string = results[0]?.languageCode ?? "en";
        const language = bcp47Lang.split("-")[0].toLowerCase();

        if (!text) {
            console.warn(`[AiService][Google STT] Empty transcript — confidence=${confidence.toFixed(3)}, language=${bcp47Lang}`);
            throw new Error("Google STT returned empty transcript");
        }

        console.log(`[AiService][Google STT] Success — language=${bcp47Lang} (→${language}), confidence=${confidence.toFixed(3)}, transcript="${text.substring(0, 80)}${text.length > 80 ? "..." : ""}"`);

        return { text, language };
    }

    // ─── Fallback: Whisper ───────────────────────────────────────
    // Original two-call Whisper logic preserved exactly.
    // Called ONLY when Google STT throws.
    private async transcribeWithWhisper(audioBuffer: Buffer, name: string): Promise<TranscribeResult> {
        console.log(`[AiService][Whisper] Starting fallback transcription — file=${name}, bytes=${audioBuffer.length}`);
 
        const medicalPrompt = "Medical symptoms described by a tourist. Translate accurately to English.";
 
        const file1 = await toFile(audioBuffer, name, { type: "audio/ogg" });
        const file2 = await toFile(audioBuffer, name, { type: "audio/ogg" });
 
        // Call 1 — detect dominant language via verbose_json
        const transcription = await this.openAi.audio.transcriptions.create({
            file: file1,
            model: WHISPER_MODEL,
            response_format: "verbose_json",
        }) as any;
        const detectedLanguage: string = transcription.language ?? "en";
 
        // Call 2 — translate to English regardless of source language
        const translation = await this.openAi.audio.translations.create({
            file: file2,
            model: WHISPER_MODEL,
            prompt: medicalPrompt,
        });
 
        const text = translation.text?.trim() ?? "";
        console.log(`[AiService][Whisper] Success — detectedLanguage=${detectedLanguage}, transcript="${text.substring(0, 80)}${text.length > 80 ? "..." : ""}"`);
 
        return { text, language: detectedLanguage };
    }
 
    // ─── Haiku Translation ───────────────────────────────────────
    // Called ONLY when Google STT succeeds AND detectedLanguage !== 'en'.
    // Translates native-language transcript to English for downstream triage.
    // Whisper path skips this — it already returns English via translations API.
    private async translateToEnglish(text: string, sourceLanguage: string): Promise<string> {
        console.log(`[AiService][Haiku Translation] Translating from language=${sourceLanguage} — input="${text.substring(0, 80)}${text.length > 80 ? "..." : ""}"`);
 
        const prompt = `You are a medical translator. Translate the following text from ${sourceLanguage} to English accurately.
        This is a medical symptom description from a tourist. Preserve all medical details exactly.
        Return ONLY the English translation — no explanation, no preamble, no quotes.
        
        Text to translate: "${text}"`;
 
        try {
            const response = await this.anthropic.messages.create({
                model: CLAUDE_HAIKU_MODEL,
                max_tokens: 500,
                temperature: 0,         // zero temperature — deterministic translation
                messages: [{ role: "user", content: prompt }],
            });

            this.recordSuccess();

            const translated = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim();
 
            console.log(`[AiService][Haiku Translation] Success — translated="${translated.substring(0, 80)}${translated.length > 80 ? "..." : ""}"`);
            return translated;
        } catch (error) {
            console.error("[AiService][Haiku Translation] Translation failed — using original text as fallback:", error);
            this.recordFailure();
            // Safe fallback: use original text, triage still proceeds
            return text;
        }
    }
 
    // ─── Public: transcribe() ────────────────────────────────────
    // Orchestrates: Google STT (primary) → Whisper (fallback) → Haiku translation (if needed)
    // Always returns English text in `text` field.
    // `language` is the original detected language (ISO 639-1).
    //
    // Invariants preserved:
    //   - No language hints passed to STT — universal detection
    //   - Transcript shown to tourist before emergency check (caller responsibility)
    //   - Gibberish check still applies after this returns
    async transcribe(audioBuffer: Buffer, name: string): Promise<TranscribeResult> {
        console.log(`[AiService][transcribe] Starting — file=${name}, bytes=${audioBuffer.length}`);
 
        let rawTranscript: TranscribeResult | null = null;
        let usedFallback = false;
 
        // ── Step 1: Try Google STT Chirp 2 ──
        try {
            rawTranscript = await this.transcribeWithGoogle(audioBuffer);
        } catch (googleError) {
            console.error("[AiService][transcribe] Google STT failed — activating Whisper fallback:", googleError);
 
            // ── Step 2: Whisper fallback ──
            try {
                rawTranscript = await this.transcribeWithWhisper(audioBuffer, name);
                usedFallback = true;
            } catch (whisperError) {
                console.error("[AiService][transcribe] Whisper fallback also failed:", whisperError);
                throw new Error("Failed to process voice message — both Google STT and Whisper failed");
            }
        }
 
        console.log(`[AiService][transcribe] STT complete — engine=${usedFallback ? "whisper(fallback)" : "google-chirp2"}, language=${rawTranscript.language}`);
 
        // ── Step 3: Translate to English if needed ──
        // Whisper path already returns English (translations API) — skip translation.
        // Google STT path returns native language — translate if not English.
        if (!usedFallback && rawTranscript.language !== "en") {
            console.log(`[AiService][transcribe] Non-English transcript detected (${rawTranscript.language}) — translating via Haiku`);
            const englishText = await this.translateToEnglish(rawTranscript.text, rawTranscript.language);
            return { text: englishText, language: rawTranscript.language };
        }
 
        // English or Whisper path — return as-is
        return rawTranscript;
    }
 
    // ─── Gibberish detection ─────────────────────────────────────
    isLikelyGibberish(text: string): boolean {
        const words = text.trim().split(/\s+/);
 
        // Too short to be a real symptom description
        if (words.length < 3) return true;
 
        // High word repetition — common Whisper hallucination pattern
        const unique = new Set(words.map((w) => w.toLowerCase()));
        if (words.length > 8 && unique.size / words.length < 0.4) return true;
 
        return false;
    }
 
    // ─── Haiku Medical Relevance Check ──────────────────────────
    // Called after transcription (audio) and before runEmergencyCheckAndIntake (text+audio).
    // Determines if the input is a medical symptom description at all.
    //
    // Returns true  → proceed with triage
    // Returns false → not a symptom — caller should strike and warn tourist
    //
    // Design decisions:
    //   - max_tokens: 10 — only {"medical":true} or {"medical":false} expected
    //   - temperature: 0 — fully deterministic, no creative variance
    //   - On any failure (API error, parse error) → returns TRUE (safe default)
    //     Reason: false negative (letting non-medical through) is safer than
    //     false positive (blocking a real tourist with a genuine symptom)
    //
    // What counts as medical:
    //   - Any physical symptom, pain, discomfort, injury, illness
    //   - Mental health symptoms (anxiety, panic, depression episode)
    //   - Medication questions in context of feeling unwell
    //   - Vague descriptions like "I feel bad" or "not feeling well" — give benefit of doubt
    //
    // What does NOT count:
    //   - Weather, directions, general questions
    //   - Greetings, test messages, random words
    //   - Complaints about the service or unrelated topics
    async isMedicalSymptom(text: string): Promise<boolean> {
        console.log(`[AiService][MedicalCheck] Checking relevance — input="${text.substring(0, 80)}${text.length > 80 ? "..." : ""}"`);
 
        const prompt = `You are a medical intake screener. Decide if the following text is describing a medical symptom, physical discomfort, injury, or health concern.
 
        Return {"medical": true} if the text:
        - Describes any physical symptom (pain, fever, nausea, dizziness, rash, injury, etc.)
        - Describes feeling unwell in any way ("I feel bad", "not feeling well", "something is wrong")
        - Asks about a health concern or medication in context of feeling sick
        - Is vague but plausibly health-related — give benefit of the doubt
        
        Return {"medical": false} if the text:
        - Is a greeting or test ("hi", "hello", "testing 1 2 3")
        - Asks about weather, food, directions, or anything unrelated to health
        - Is a complaint about the service
        - Is random words or clearly off-topic
        
        Text: "${text}"
        
        Reply ONLY with {"medical": true} or {"medical": false}. No explanation.`;
 
        try {
            const response = await this.anthropic.messages.create({
                model: CLAUDE_HAIKU_MODEL,
                max_tokens: 10,
                temperature: 0,
                messages: [{ role: "user", content: prompt }],
            });
 
            this.recordSuccess();

            const raw = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim()
                .replace(/^```json\s*/i, "")
                .replace(/```$/, "")
                .trim();
 
            console.log(`[AiService][MedicalCheck] Haiku response: ${raw}`);
            const parsed = JSON.parse(raw);
            const result = parsed.medical === true;
            console.log(`[AiService][MedicalCheck] Result — isMedical=${result}`);
            return result;
 
        } catch (error) {
            // Safe default: pass through on any failure — never block a real tourist
            console.error("[AiService][MedicalCheck] Check failed — defaulting to true (safe pass-through):", error);

            this.recordFailure();

            return true;
        }
    }
 
    // ─── Haiku Emergency Context Check ──────────────────────────
    // attempt=1 on first call; retried once (attempt=2) on SyntaxError before
    // giving up and throwing EmergencyCheckUncertainError → YES/NO prompt.
    async isEmergencyContext(symptomText: string, attempt = 1): Promise<boolean> {
        console.log(`[AiService][EmergencyCheck] Attempt=${attempt} — symptom="${symptomText.substring(0, 60)}${symptomText.length > 60 ? "..." : ""}"`);
 
        const prompt = `You are a medical emergency screener. Your ONLY job is to detect life-threatening emergencies.
 
        Return {"emergency": true} ONLY if the symptoms describe one or more of these exact conditions:
        - Unconscious or unresponsive
        - Not breathing or stopped breathing
        - Collapsed (sudden, complete loss of posture — not just weakness or fatigue)
        - Anaphylaxis or throat closing
        - Active seizure or febrile seizure
        - Uncontrolled or major bleeding
        - Heart attack symptoms (chest pain + arm/jaw pain)
        - Stroke symptoms (face drooping, arm weakness, slurred speech simultaneously)
 
        Return {"emergency": false} for:
        - General weakness, fatigue, or tiredness
        - Inability to stand due to weakness or dizziness (not collapse/syncope)
        - Stomach problems, nausea, vomiting, diarrhoea
        - Fever, headache, body ache
        - Any symptom that is uncomfortable but not immediately life-threatening
 
        The tourist's symptoms: "${symptomText}"
 
        Do not write anything other than the JSON object. No greeting, no explanation. ONLY: {"emergency": true} or {"emergency": false}`;
 
        try {
            const response = await this.anthropic.messages.create({
                model: CLAUDE_HAIKU_MODEL,
                max_tokens: 20,
                temperature: 0,
                messages: [{ role: "user", content: prompt }],
            });
 
            const raw = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("");
 
            const clean = raw.trim()
                .replace(/^```json\s*/i, "")
                .replace(/```$/, "")
                .trim();
 
            console.log(`[AiService][EmergencyCheck] Haiku raw response: ${clean}`);
            const parsed = JSON.parse(clean);

            this.recordSuccess();

            const isEmergency = parsed.emergency === true;
            console.log(`[AiService][EmergencyCheck] Result — isEmergency=${isEmergency}`);
            return isEmergency;
        } catch (error) {
            
            this.recordFailure();

            if (error instanceof SyntaxError) {
                if (attempt === 1) {
                    console.warn("[AiService][EmergencyCheck] Haiku returned non-JSON on attempt 1 — retrying");
                    return this.isEmergencyContext(symptomText, 2);
                }
                console.error("[AiService][EmergencyCheck] Haiku returned non-JSON after retry — escalating to UNCERTAIN");
            } else {
                console.error("[AiService][EmergencyCheck] API/network error:", error);
            }
            throw new EmergencyCheckUncertainError();
        }
    }
 
    // ─── Haiku Enriched Triage (post MCQ) ───────────────────────
    async runEnrichedTriage(
        symptomText: string,
        intakeAnswers: IntakeAnswers,
    ): Promise<TriageResult> {
        console.log(`[AiService][EnrichedTriage] Starting — symptom="${symptomText.substring(0, 60)}${symptomText.length > 60 ? "..." : ""}"`);
 
        const prompt = `
        You are a medical triage assistant for tourists visiting India. 
        Your goal is to map the user to the correct "Care Layer" based on safety and medical necessity.
 
        Tourist's symptom description: "${symptomText}"
 
        Intake answers:
        - Severity: ${intakeAnswers.q1 ?? "not provided"}
        - Trajectory: ${intakeAnswers.q2 ?? "not provided"}
        - Duration: ${intakeAnswers.q3 ?? "not provided"}
        - Functional impact: ${intakeAnswers.q4 ?? "not provided"}
        - Associated symptoms: ${intakeAnswers.q5 ?? "not provided"}
 
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
                model: CLAUDE_HAIKU_MODEL,
                max_tokens: 500,
                temperature: 0.1,
                messages: [{ role: "user", content: prompt }],
            });
 
            const raw = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("");
 
            const clean = raw.trim()
                .replace(/^```json\s*/i, "")
                .replace(/```$/, "")
                .trim();
 
            console.log(`[AiService][EnrichedTriage] Result: ${clean}`);
            const parsed = JSON.parse(clean);
            this.recordSuccess();
            return parsed as TriageResult;
        } catch (error) {
            console.error("[AiService][EnrichedTriage] Failed — defaulting to L3:", error);
            this.recordFailure()
            return {
                severity: "moderate",
                care_layer: 3,
                summary: "Unable to classify symptoms accurately",
                speciality_needed: "general physician",
                ai_guidance: "",
                emergency_flag: false,
            };
        }
    }
 
    // ─── Sonnet L1 Guidance ──────────────────────────────────────
    async getL1Guidance(
        symptomText: string,
        intakeAnswers: IntakeAnswers,
        language: string = "en",
    ): Promise<string> {
        console.log(`[AiService][L1Guidance] Starting — language=${language}, symptom="${symptomText.substring(0, 60)}${symptomText.length > 60 ? "..." : ""}"`);
 
        const languageNames: Record<string, string> = {
            en: "English", hi: "Hindi", bn: "Bengali",
            fr: "French", de: "German", es: "Spanish",
            ja: "Japanese", zh: "Chinese", ar: "Arabic",
            ru: "Russian", pt: "Portuguese", ko: "Korean",
        };
        const languageName = languageNames[language] ?? "English";
 
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
        Severity: ${intakeAnswers.q1 ?? "mild"}
        Trajectory: ${intakeAnswers.q2 ?? "staying same"}
        Duration: ${intakeAnswers.q3 ?? "few hours"}
        Functional impact: ${intakeAnswers.q4 ?? "moving fine"}
        Associated symptoms: ${intakeAnswers.q5 ?? "none"}
 
        Respond in ${languageName}.`;
 
        try {
            const response = await this.anthropic.messages.create({
                model: CLAUSE_SONNET,
                max_tokens: 1000,
                temperature: 0.7,
                system: systemPrompt,
                messages: [{ role: "user", content: userPrompt }],
            });
            this.recordSuccess();
            const guidance = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim();
 
            console.log(`[AiService][L1Guidance] Success — responseLength=${guidance.length}`);
            return guidance;
        } catch (error) {
            console.error("[AiService][L1Guidance] Failed — using hardcoded fallback:", error);
            this.recordFailure();
            return "Please rest, stay hydrated, and monitor your symptoms. Drink plenty of water and avoid exertion.";
        }
    }
 
    // ─── Sonnet L1 Guidance — After Hours ───────────────────────
    async getL1GuidanceAfterHours(
        symptomText: string,
        intakeAnswers: IntakeAnswers,
        language: string = "en",
    ): Promise<string> {
        console.log(`[AiService][L1GuidanceAfterHours] Starting — language=${language}, symptom="${symptomText.substring(0, 60)}${symptomText.length > 60 ? "..." : ""}"`);
 
        const languageNames: Record<string, string> = {
            en: "English", hi: "Hindi", bn: "Bengali",
            fr: "French", de: "German", es: "Spanish",
            ja: "Japanese", zh: "Chinese", ar: "Arabic",
            ru: "Russian", pt: "Portuguese", ko: "Korean",
        };
        const languageName = languageNames[language] ?? "English";
 
        const systemPrompt = `You are a compassionate medical guidance assistant for tourists who are experiencing symptoms at night, when clinics are closed.
 
        SITUATION: The tourist is in a hotel room. It is nighttime. No clinic is available until morning. Hotel staff may be able to help with basic items.
        
        STRICT RULES — NEVER VIOLATE:
        1. Never name specific medicines, brands, or drug molecules
        2. Never give dosage instructions of any kind
        3. Never suggest anything requiring a prescription
        4. Never diagnose a condition by name
        5. Keep response to 3-4 short steps maximum
        6. Warm, calm, reassuring tone — tourist is anxious and it is nighttime
        
        WHAT YOU CAN SUGGEST:
        - Rest and sleep
        - Hydration (plain water, coconut water, clear fluids)
        - Light easily digestible food (plain rice, toast, banana)
        - Positioning (elevate legs, sit upright, lie on left side)
        - Temperature management (cool wet cloth on forehead, warm compress on stomach)
        - Breathing techniques for anxiety or mild breathlessness
        - ONE generic OTC category if genuinely needed — phrased as "a simple painkiller available at any pharmacy" — never a name
        
        HOTEL STAFF CONTEXT (include naturally if relevant):
        - Tourist can call hotel reception for: extra blankets, hot water, basic first aid kit
        - Tourist can ask hotel staff: "Do you have anything for fever/stomach discomfort?"
        - Phrase as a gentle suggestion, not a medical instruction
        - Never specify what drug the hotel staff should provide`;
 
        const userPrompt = `Tourist symptom: "${symptomText}"
        Severity: ${intakeAnswers.q1 ?? "unknown"}
        Trajectory: ${intakeAnswers.q2 ?? "unknown"}
        Duration: ${intakeAnswers.q3 ?? "unknown"}
        Functional impact: ${intakeAnswers.q4 ?? "unknown"}
        Associated symptoms: ${intakeAnswers.q5 ?? "none"}
        
        It is currently nighttime and clinics are closed. Respond in ${languageName}.`;
 
        try {
            const response = await this.anthropic.messages.create({
                model: CLAUSE_SONNET,
                max_tokens: 1000,
                temperature: 0.7,
                system: systemPrompt,
                messages: [{ role: "user", content: userPrompt }],
            });
 
            const guidance = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim();
 
            console.log(`[AiService][L1GuidanceAfterHours] Success — responseLength=${guidance.length}`);
            this.recordSuccess();
            return guidance;
        } catch (error) {
            console.error("[AiService][L1GuidanceAfterHours] Failed — rethrowing for caller fallback:", error);
            this.recordFailure();
            throw error;     
        }
    }
}