import { RankedClinic } from 'src/client/clinic.types';
import { ConsultationType } from 'src/generated/prisma/enums';
import { TriageResult } from 'src/types/session.types';

export interface CreateBookingInput {
    touristPhone: string;        // used to find or create Tourist row
    clinic: RankedClinic;        // selected clinic from list
    triageResult: TriageResult;  // full Haiku output
    symptomText: string;         // raw tourist input
    hotelId?: string;            // null if tourist entered independently
    roomNumber?: string;         // null if no hotel
    consultationType?: ConsultationType;
}

export interface BookingConfirmation {
    bookingCode: string;         // MED-XXXX — tourist-facing
    displayName: string;         // clinic display name — never real name
    visitWindow: string;         // e.g. "2pm – 5pm today"
    feeOpd: number;              // in paise — passed to payment service
    bookingId: string;           // internal DB id — passed to payment service
    touristId: string;           // internal — passed to payment service
}