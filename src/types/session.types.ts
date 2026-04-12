export type SessionStep =
    | 'IDLE'
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

export interface WaSession {
    phone: string;
    step: SessionStep;
    symptomText: string;
    intakeAnswers: IntakeAnswers;
    triageResult?: {
        severity: string;
        careLayer: number;
        summary: string;
        specialityNeeded: string;
        aiGuidance: string;
        emergencyFlag: boolean;
    };
    clinicOptions?: any[];
    selectedClinicId?: string;
    bookingId?: string;
    hotelId?: string;
    lastUpdated: number;
}

export const DEFAULT_SESSION = (phone: string): WaSession => ({
    phone,
    step: 'IDLE',
    symptomText: '',
    intakeAnswers: {},
    lastUpdated: Date.now()
})