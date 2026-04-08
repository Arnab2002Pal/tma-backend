import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI, { toFile } from "openai";

@Injectable()
export class AiService {
    private openAi: OpenAI;

    constructor(private config: ConfigService) {
        this.openAi = new OpenAI({
            apiKey: this.config.get<string>('OPENAI_API_KEY'),
        })
    }

    async transcribe(audiobuffer: Buffer, name: string): Promise<string> {
        try {
            const file = await toFile(audiobuffer, name, { type: 'audio/ogg' })
            const transcription = await this.openAi.audio.transcriptions.create({
                file: file,
                model: 'whisper-1',
                language: 'en', // Forces English output for medical consistency
                prompt: 'Medical triage for a tourist in India.',
            })
            return transcription.text;

        } catch (error) {
            console.error('Transcription Error:', error);
            throw new Error('Failed to process voice message');
        }
    }
}