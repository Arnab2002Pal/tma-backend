// Generates a printable PDF for a hotel.
// One page per room. Pages grouped by floor.
// Each page: QR code (centered) + hotel display name + floor label + room number + scan instruction.
//
// Libraries:
//   qrcode   — pure Node, generates QR as PNG buffer or SVG string
//   pdfkit   — pure Node PDF generation, no browser required
//
// Install: npm install qrcode pdfkit
// Types:   npm install --save-dev @types/qrcode @types/pdfkit

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { GenerateHotelQrInput, GenerateHotelQrResult, ResolvedRoom } from './hotel-qr.types';
import { deriveRooms } from './room-number.util';

// A4 dimensions in points (72 points = 1 inch)
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

// QR code size on the page — large enough to scan from 60cm
const QR_SIZE_PX = 300;

// Colours — keep it clean for print
const COLOR_PRIMARY = '#1a1a1a';
const COLOR_SECONDARY = '#555555';
const COLOR_ACCENT = '#0f6e56';    // TMA teal — matches brand

@Injectable()
export class QrService {
    private readonly logger = new Logger(QrService.name);

    constructor(private readonly config: ConfigService) { }

    // ─── Public API ─────────────────────────────────────────────────────────────

    /**
     * Generate QR codes and PDF for all rooms in a hotel.
     * Returns the PDF as a Buffer — caller streams it as application/pdf.
     *
     * Also returns the structured room data for persisting to HotelRoom table.
     */
    async generateHotelQrPdf(
        input: GenerateHotelQrInput,
        hotelDisplayName: string,
    ): Promise<GenerateHotelQrResult> {
        const { hotelId, hotelToken, floors, baseUrl } = input;

        // 1 — Derive all room numbers from floor config
        const floorGroups = deriveRooms(floors, hotelToken, baseUrl);
        const totalRooms = floorGroups.reduce((sum, f) => sum + f.rooms.length, 0);

        this.logger.log(
            `[QR] Generating PDF for hotel ${hotelId}: ${totalRooms} rooms across ${floorGroups.length} floors`,
        );

        // 2 — Build PDF
        const pdfBuffer = await this.buildPdf(hotelDisplayName, floorGroups);

        this.logger.log(`[QR] PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)}KB`);

        return {
            hotelId,
            totalRooms,
            floors: floorGroups,
            pdfBuffer,
        };
    }

    // ─── PDF construction ────────────────────────────────────────────────────────

    private async buildPdf(
        hotelDisplayName: string,
        floorGroups: { floorNumber: number; rooms: ResolvedRoom[] }[],
    ): Promise<Buffer> {
        return new Promise(async (resolve, reject) => {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 0,
                autoFirstPage: false,
                info: {
                    Title: `TMA QR Codes — ${hotelDisplayName}`,
                    Author: 'Tourist Medical Assistance',
                    Subject: 'Room QR codes for WhatsApp medical assistance',
                },
            });

            const chunks: Buffer[] = [];
            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // One page per room, grouped by floor
            for (const { floorNumber, rooms } of floorGroups) {
                for (const room of rooms) {
                    doc.addPage();
                    await this.drawRoomPage(doc, hotelDisplayName, floorNumber, room);
                }
            }

            doc.end();
        });
    }

    /**
     * Draw one room page.
     *
     * Layout (A4, portrait):
     *   - Top strip: TMA brand label + hotel name
     *   - Center: QR code (300×300)
     *   - Below QR: room number (large) + floor label
     *   - Bottom: scan instruction
     *   - Footer: "In case of medical emergency, call 112"
     */
    private async drawRoomPage(
        doc: PDFKit.PDFDocument,
        hotelDisplayName: string,
        floorNumber: number,
        room: ResolvedRoom,
    ): Promise<void> {
        const centerX = PAGE_WIDTH / 2;

        // ── Top strip ────────────────────────────────────────────────────────────
        // Thin teal top bar — brand anchor
        doc.rect(0, 0, PAGE_WIDTH, 6).fill(COLOR_ACCENT);

        // TMA label
        doc
            .font('Helvetica-Bold')
            .fontSize(11)
            .fillColor(COLOR_ACCENT)
            .text('TMA — Tourist Medical Assistance', 0, 24, {
                width: PAGE_WIDTH,
                align: 'center',
            });

        // Hotel name
        doc
            .font('Helvetica')
            .fontSize(13)
            .fillColor(COLOR_PRIMARY)
            .text(hotelDisplayName, 0, 44, {
                width: PAGE_WIDTH,
                align: 'center',
            });

        // Thin divider line
        doc
            .moveTo(60, 70)
            .lineTo(PAGE_WIDTH - 60, 70)
            .strokeColor('#e0e0e0')
            .lineWidth(0.5)
            .stroke();

        // ── QR code ──────────────────────────────────────────────────────────────
        const qrBuffer = await this.generateQrBuffer(room.qrUrl);
        const qrX = centerX - QR_SIZE_PX / 2;
        const qrY = 100;

        // Subtle border around QR for clean print cutting
        doc
            .rect(qrX - 8, qrY - 8, QR_SIZE_PX + 16, QR_SIZE_PX + 16)
            .strokeColor('#f0f0f0')
            .lineWidth(1)
            .stroke();

        doc.image(qrBuffer, qrX, qrY, {
            width: QR_SIZE_PX,
            height: QR_SIZE_PX,
        });

        // ── Room number ───────────────────────────────────────────────────────────
        const belowQr = qrY + QR_SIZE_PX + 28;

        doc
            .font('Helvetica-Bold')
            .fontSize(52)
            .fillColor(COLOR_PRIMARY)
            .text(`Room ${room.roomNumber}`, 0, belowQr, {
                width: PAGE_WIDTH,
                align: 'center',
            });

        // Floor label — smaller, muted
        doc
            .font('Helvetica')
            .fontSize(14)
            .fillColor(COLOR_SECONDARY)
            .text(`Floor ${floorNumber}`, 0, belowQr + 62, {
                width: PAGE_WIDTH,
                align: 'center',
            });

        // ── Scan instruction ──────────────────────────────────────────────────────
        const instructionY = belowQr + 100;

        doc
            .rect(80, instructionY, PAGE_WIDTH - 160, 64)
            .fillColor('#f8f8f8')
            .fill();

        doc
            .font('Helvetica-Bold')
            .fontSize(13)
            .fillColor(COLOR_PRIMARY)
            .text('Feeling unwell?', 0, instructionY + 12, {
                width: PAGE_WIDTH,
                align: 'center',
            });

        doc
            .font('Helvetica')
            .fontSize(11)
            .fillColor(COLOR_SECONDARY)
            .text('Scan this QR code for instant medical assistance via WhatsApp', 0, instructionY + 30, {
                width: PAGE_WIDTH,
                align: 'center',
            });

        // ── Footer ────────────────────────────────────────────────────────────────
        const footerY = PAGE_HEIGHT - 48;

        doc
            .moveTo(60, footerY - 8)
            .lineTo(PAGE_WIDTH - 60, footerY - 8)
            .strokeColor('#e0e0e0')
            .lineWidth(0.5)
            .stroke();

        doc
            .font('Helvetica-Bold')
            .fontSize(10)
            .fillColor('#cc0000')
            .text('Medical emergency? Call 112 immediately.', 0, footerY, {
                width: PAGE_WIDTH,
                align: 'center',
            });

        // Bottom teal bar — mirrors top
        doc.rect(0, PAGE_HEIGHT - 6, PAGE_WIDTH, 6).fill(COLOR_ACCENT);
    }

    // ─── QR code generation ──────────────────────────────────────────────────────

    /**
     * Generate a QR code PNG buffer for a URL.
     * Error correction level H (30%) — handles minor print damage.
     * Margin 2 — tighter but still scannable.
     */
    private async generateQrBuffer(url: string): Promise<Buffer> {
        return QRCode.toBuffer(url, {
            type: 'png',
            width: QR_SIZE_PX * 2,   // 2× for print resolution (150 DPI equivalent)
            margin: 2,
            errorCorrectionLevel: 'H',
            color: {
                dark: '#000000',
                light: '#ffffff',
            },
        });
    }
}