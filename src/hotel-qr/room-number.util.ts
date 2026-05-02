// src/hotel-qr/room-number.util.ts
//
// Pure utility — no dependencies, fully unit-testable.
// Derives room numbers from floor configuration using the standard
// hospitality convention: roomNumber = (floorNumber * 100) + roomIndex
//
// Examples:
//   floor 1, 10 rooms → "101" … "110"
//   floor 3,  5 rooms → "301" … "305"
//   floor 12, 8 rooms → "1201" … "1208"  (4-digit, high floors)

import { FloorInput, ResolvedRoom } from './hotel-qr.types';

/**
 * Derive all room numbers for a hotel from floor configuration.
 * Returns rooms grouped by floor, in floor order.
 */
export function deriveRooms(
    floors: FloorInput[],
    hotelToken: string,
    baseUrl: string,
): { floorNumber: number; rooms: ResolvedRoom[] }[] {
    return floors
        .sort((a, b) => a.floorNumber - b.floorNumber)
        .map(({ floorNumber, roomCount }) => {
            const rooms: ResolvedRoom[] = [];

            for (let i = 1; i <= roomCount; i++) {
                const roomNumber = String(floorNumber * 100 + i);
                const qrUrl = buildQrUrl(baseUrl, hotelToken, roomNumber);
                rooms.push({ floorNumber, roomNumber, qrUrl });
            }

            return { floorNumber, rooms };
        });
}

/**
 * Build the full URL encoded in each QR code.
 * Format: {baseUrl}/h/{hotelToken}?room={roomNumber}
 *
 * This URL is handled by hotel-qr.controller.ts GET /h/:token
 * which validates the token, looks up the hotel, and redirects
 * to the wa.me deeplink with a prefilled START message.
 */
export function buildQrUrl(
    baseUrl: string,
    hotelToken: string,
    roomNumber: string,
): string {
    return `${baseUrl}/h/${hotelToken}?room=${encodeURIComponent(roomNumber)}`;
}

/**
 * Build the wa.me deeplink that the QR redirect lands on.
 * The prefilled text is: START {hotelToken} {roomNumber}
 *
 * When the tourist sends this, whatsapp.service.ts parses it and
 * hydrates the session with hotelId + roomNumber.
 */
export function buildWaMeDeeplink(
    wabaPhone: string,   // E.164 without +, e.g. "919876543210"
    hotelToken: string,
    roomNumber: string,
): string {
    const text = encodeURIComponent(`START ${hotelToken} ${roomNumber}`);
    return `https://wa.me/${wabaPhone}?text=${text}`;
}