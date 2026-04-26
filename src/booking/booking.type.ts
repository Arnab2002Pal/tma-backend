import { RankedClinic } from 'src/client/clinic.types';
import { ConsultationType } from 'src/generated/prisma/enums';
import { TriageResult } from 'src/types/session.types';

export interface CreateBookingInput {
    touristPhone: string;        // used to find or create Tourist row
    clinic: RankedClinic;        // selected clinic from list
    triageResult: TriageResult;  // full Haiku output
    symptomText: string;         // raw tourist input
    hotelId: string;             // always required in Phase 1 — tourist enters via hotel QR
    roomNumber?: string;         // null if room not captured (shouldn't happen in Phase 1)
    consultationType?: ConsultationType;
    language: string;           // ISO code, e.g. 'en', 'hi' — used to set tourist preferredLanguage at booking time
}

export interface BookingConfirmation {
    bookingCode: string;         // MED-XXXX — tourist-facing
    displayName: string;         // clinic display name — never real name
    visitWindow: string;         // e.g. "2pm – 5pm today"
    feeOpd: number;              // in paise — passed to payment service
    bookingId: string;           // internal DB id — passed to payment service
    touristId: string;           // internal — passed to payment service
}