// src/hotel-qr/hotel-qr.service.ts
//
// Handles:
//   1. Generating and persisting rooms for a hotel (called at onboarding)
//   2. Resolving a qrToken to a hotel + building the wa.me redirect URL
//   3. Streaming the PDF for a given hotel

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/prisma.service';
import { QrService } from './qr.service';
import { FloorInput, GenerateHotelQrResult } from './hotel-qr.types';
import { buildWaMeDeeplink } from './room-number.util';

@Injectable()
export class HotelQrService {
    private readonly logger = new Logger(HotelQrService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        private readonly qrService: QrService,
    ) { }

    // ─── Generate + persist rooms + return PDF ───────────────────────────────────

    /**
     * Called once during hotel onboarding (or when rooms are updated).
     *
     * 1. Validates hotel exists
     * 2. Derives all room numbers from floor config
     * 3. Generates QR codes and PDF
     * 4. Persists HotelRoom rows (upsert — safe to call again)
     * 5. Updates Hotel.totalRooms
     * 6. Returns PDF buffer for the caller to stream
     */
    async generateAndPersistRooms(
        hotelId: string,
        floors: FloorInput[],
    ): Promise<GenerateHotelQrResult> {
        // 1 — Load hotel
        const hotel = await this.prisma.hotel.findUniqueOrThrow({
            where: { id: hotelId },
            select: { id: true, qrToken: true, name: true },
        });

        const baseUrl = this.config.getOrThrow<string>('BASE_URL'); // e.g. https://tma.app

        // 2 + 3 — Generate rooms and PDF
        const result = await this.qrService.generateHotelQrPdf(
            {
                hotelId: hotel.id,
                hotelToken: hotel.qrToken,
                floors,
                baseUrl,
            },
            hotel.name,
        );

        // 4 — Persist HotelRoom rows (upsert on hotelId+roomNumber)
        const upsertOps = result.floors.flatMap(({ rooms }) =>
            rooms.map((room) =>
                this.prisma.hotelRoom.upsert({
                    where: {
                        hotelId_roomNumber: {
                            hotelId: hotel.id,
                            roomNumber: room.roomNumber,
                        },
                    },
                    update: {
                        floorNumber: room.floorNumber,
                        qrUrl: room.qrUrl,
                    },
                    create: {
                        hotelId: hotel.id,
                        floorNumber: room.floorNumber,
                        roomNumber: room.roomNumber,
                        qrUrl: room.qrUrl,
                    },
                }),
            ),
        );

        await this.prisma.$transaction(upsertOps);

        // 5 — Update totalRooms on Hotel
        await this.prisma.hotel.update({
            where: { id: hotelId },
            data: { totalRooms: result.totalRooms },
        });

        this.logger.log(
            `[HotelQR] Persisted ${result.totalRooms} rooms for hotel ${hotelId}`,
        );

        return result;
    }

    // ─── QR token resolution (called by controller on tourist scan) ──────────────

    /**
  * Resolves a qrToken to a wa.me deeplink.
  * Called by GET /h/:token?room=XXX
  *
  * Flow:
  *   1. Validate qrToken against Hotel.qrToken
  *   2. Build a natural prefilled WhatsApp message that embeds hotelId + roomNumber
  *      in a readable format: "I need medical help. Room 303 · Taj Bengal · TMA-{hotelId}-303"
  *   3. Return wa.me deeplink — controller does the 302 redirect
  *
  * Why embed hotelId + roomNumber in the message text:
  *   WhatsApp deeplinks cannot carry metadata. The tourist's phone number is unknown
  *   until the webhook fires. The only way to bridge the scan event to the incoming
  *   message is to encode context in the prefilled text itself.
  *   TMA-{hotelId}-{roomNumber} at the end acts as a machine-readable reference
  *   while the rest reads naturally to the tourist.
  *
  * Edge cases handled:
  *   - Invalid qrToken → NotFoundException (controller shows 404 HTML page)
  *   - Missing room param → controller defaults to "unknown" before calling this
  *   - Room not in HotelRoom table → still redirects (room may have been added manually)
  *   - Hotel name contains special characters → encodeURIComponent handles encoding
  *
  * Throws NotFoundException if token is invalid — never hints at what a valid token looks like.
  */
    async resolveTokenToDeeplink(qrToken: string, roomNumber: string): Promise<string> {
        const hotel = await this.prisma.hotel.findUnique({
            where: { qrToken },
            select: { id: true, name: true },
        });

        if (!hotel) {
            this.logger.warn(
                `[HotelQR] Invalid qrToken attempted: ${qrToken.slice(0, 8)}…`,
            );
            throw new NotFoundException('QR code not recognised.');
        }

        // Validate room exists for this hotel — log warning if not, but still redirect.
        // The WhatsApp handler validates hotelId; roomNumber is informational in Phase 1.
        const room = await this.prisma.hotelRoom.findUnique({
            where: { hotelId_roomNumber: { hotelId: hotel.id, roomNumber } },
        });

        if (!room) {
            this.logger.warn(
                `[HotelQR] Unknown room ${roomNumber} for hotel ${hotel.id} — redirecting anyway`,
            );
        }

        const wabaPhone = this.config.getOrThrow<string>('WHATSAPP_PHONE_NUMBER');

        // Prefilled message format:
        //   "I need medical help. Room 303 · Taj Bengal · TMA-{hotelId}-303"
        //
        // The human-readable part ("I need medical help. Room 303 · Taj Bengal") gives
        // the tourist context and looks natural. The TMA-{hotelId}-{roomNumber} suffix
        // is the machine-readable bridge parsed by WhatsappQrHandler.handleStart().
        //
        // · (U+00B7 middle dot) used as separator — visually clean, won't appear in
        //   hotel names or room numbers, safe after encodeURIComponent.
        const prefillText = `I need medical help. Room ${roomNumber} · ${hotel.name} · TMA-${hotel.id}-${roomNumber}`;
        const text = encodeURIComponent(prefillText);

        this.logger.log(
            `[HotelQR] Deeplink built for hotel=${hotel.id} room=${roomNumber}`,
        );

        return `https://wa.me/${wabaPhone}?text=${text}`;
    }

    // ─── PDF download (for hotel dashboard or re-print) ──────────────────────────

    /**
     * Re-generate PDF for an existing hotel on demand.
     * Used by the hotel dashboard "Download QR codes" button (Phase 2).
     * Also useful for re-printing after adding rooms.
     */
    async getPdfForHotel(hotelId: string): Promise<Buffer> {
        const hotel = await this.prisma.hotel.findUniqueOrThrow({
            where: { id: hotelId },
            select: { id: true, qrToken: true, name: true },
        });

        const rooms = await this.prisma.hotelRoom.findMany({
            where: { hotelId },
            orderBy: [{ floorNumber: 'asc' }, { roomNumber: 'asc' }],
        });

        if (rooms.length === 0) {
            throw new NotFoundException('No rooms found for this hotel. Generate rooms first.');
        }

        // Reconstruct floor groups from persisted rooms
        const floorMap = new Map<number, { floorNumber: number; roomCount: number }>();
        for (const room of rooms) {
            const existing = floorMap.get(room.floorNumber);
            if (existing) {
                existing.roomCount++;
            } else {
                floorMap.set(room.floorNumber, { floorNumber: room.floorNumber, roomCount: 1 });
            }
        }

        const baseUrl = this.config.getOrThrow<string>('BASE_URL');
        const result = await this.qrService.generateHotelQrPdf(
            {
                hotelId: hotel.id,
                hotelToken: hotel.qrToken,
                floors: Array.from(floorMap.values()),
                baseUrl,
            },
            hotel.name,
        );

        return result.pdfBuffer;
    }
}