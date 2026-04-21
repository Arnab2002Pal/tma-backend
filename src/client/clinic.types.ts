// Clinic matching types — internal use only

export interface ClinicAvailableHours {
    open: number;  // IST hour e.g. 9
    close: number; // IST hour e.g. 21
}

export interface RankedClinic {
    id: string;
    displayName: string;       // tourist-facing ONLY — never real name
    distanceKm: number;        // from hotel coordinates
    distanceText: string;      // e.g. "1.2 km"
    speciality: string;        // matched speciality for display
    languages: string[];
    feeOpd: number;            // in paise
    feeNight: number;          // in paise
    compositeScore: number;    // ranking score — not exposed to tourist
    isGpFallback: boolean;     // true if expanded to general physician
}

export interface ClinicMatchInput {
    city: string;
    specialityNeeded: string;
    detectedLanguage: string;  // ISO 639-1
    hotelLat: number;
    hotelLng: number;
}