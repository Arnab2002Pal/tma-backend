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
    detectedLanguage: string; 
    intakeAnswers: IntakeAnswers;
    triageResult?: TriageResult;      // ← use the interface, not inline type
    clinicOptions?: any[];
    selectedClinicId?: string;
    bookingId?: string;
    hotelId?: string;
    lastUpdated: number;
}

export const DEFAULT_SESSION = (phone: string): WaSession => ({
    phone,
    step: 'IDLE',
    detectedLanguage: 'en',
    symptomText: '',
    intakeAnswers: {},
    lastUpdated: Date.now()
})