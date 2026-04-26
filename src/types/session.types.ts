export type SessionStep =
    | 'IDLE'
    | 'AWAITING_SYMPTOM_CONFIRM'
    | 'AWAITING_EMERGENCY_CONFIRM'
    | 'AWAITING_Q1'
    | 'AWAITING_Q2'
    | 'AWAITING_Q3'
    | 'AWAITING_Q4'
    | 'AWAITING_Q5'
    | 'AWAITING_TRIAGE'
    | 'CLINIC_SELECTION'
    | 'AWAITING_PAYMENT'
    | 'CONFIRMED'
    | 'POST_VISIT';

export interface IntakeAnswers {
    q1?: string; // severity
    q2?: string; // trajectory
    q3?: string; // duration
    q4?: string; // functional impact
    q5?: string; // associated flags
}

export interface TriageResult {
    severity: 'mild' | 'moderate' | 'serious' | 'emergency';
    care_layer: 1 | 2 | 3 | 4;
    summary: string;
    speciality_needed: string;
    ai_guidance: string;
    emergency_flag: boolean;
}

export interface WaSession {
    phone: string;
    step: SessionStep;
    symptomText: string;
    detectedLanguage: string;       // ISO 639-1 from Whisper verbose_json
    intakeAnswers: IntakeAnswers;
    triageResult?: TriageResult;
    clinicOptions?: any[];          // RankedClinic[] — stored as any to avoid circular deps
    selectedClinicId?: string;
    bookingId?: string;
    hotelId?: string;               // null if tourist entered independently (not via hotel QR)
    roomNumber?: string;            // v4.2 — e.g. "106", null if no hotel
    isAfterHours?: boolean;         // v4.2 — set when after-hours path triggered
    lastUpdated: number;
}

export const DEFAULT_SESSION = (phone: string): WaSession => ({
    phone,
    step: 'IDLE',
    detectedLanguage: 'en',
    symptomText: '',
    intakeAnswers: {},
    lastUpdated: Date.now(),
});