// src/hotel-qr/hotel-qr.types.ts

/**
 * One floor entry provided during hotel onboarding.
 * floorNumber: 1, 2, 3 …
 * roomCount:   number of rooms on this floor (e.g. 10 → rooms 101–110)
 */
export interface FloorInput {
    floorNumber: number;
    roomCount: number;
}

/**
 * Full input for generating QR codes for a hotel.
 * Called once during onboarding or whenever rooms are regenerated.
 */
export interface GenerateHotelQrInput {
    hotelId: string;
    hotelToken: string;     // qrToken from Hotel model — the opaque URL segment
    floors: FloorInput[];
    baseUrl: string;        // e.g. "https://tma.app" — injected from config
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * One resolved room — derived from FloorInput.
 * roomNumber is always a string (e.g. "305") to support future custom labels.
 */
export interface ResolvedRoom {
    floorNumber: number;
    roomNumber: string;
    qrUrl: string;
}

// ─── Output ──────────────────────────────────────────────────────────────────

export interface GenerateHotelQrResult {
    hotelId: string;
    totalRooms: number;
    floors: {
        floorNumber: number;
        rooms: ResolvedRoom[];
    }[];
    pdfBuffer: Buffer;    // ready to stream as application/pdf
}