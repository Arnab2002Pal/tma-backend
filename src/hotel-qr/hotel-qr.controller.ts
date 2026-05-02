import {
    Body,
    Controller,
    Get,
    HttpCode,
    Logger,
    NotFoundException,
    Param,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import type { Response } from 'express'; 
import { HotelQrService } from './hotel-qr.service';
import { FloorInput } from './hotel-qr.types';

@Controller()
export class HotelQrController {
    private readonly logger = new Logger(HotelQrController.name);

    constructor(private readonly hotelQrService: HotelQrService) { }

    // ─── Public: QR scan redirect ────────────────────────────────────────────────

    /**
     * GET /h/:token?room=305
     *
     * Entry point for every tourist scan. No auth required — this URL is
     * printed on QR codes and must be publicly reachable.
     *
     * Flow:
     *   1. Validate token against Hotel.qrToken
     *   2. Build wa.me deeplink with prefilled START message
     *   3. 302 redirect — tourist's phone opens WhatsApp
     *
     * On invalid token: 404. Never reveal whether a token is "close" or "wrong format".
     * On missing room param: still redirect — room defaults to "unknown" and the
     *   WhatsApp handler will ask them to re-scan.
     */
    @Get('h/:token')
    async handleQrScan(
        @Param('token') token: string,
        @Query('room') room: string,
        @Res() res: Response
    ) {
        try {
            const roomNumber = room?.trim() || 'unknown';
            const deeplink = await this.hotelQrService.resolveTokenToDeeplink(token, roomNumber);

            this.logger.log(
                `[QRScan] token=${token.slice(0, 8)}… room=${roomNumber} → redirect`,
            );

            console.log(`[QRScan] token=${token.slice(0, 8)}… room=${roomNumber} → redirect to ${deeplink}`);

            return res.redirect(302, deeplink);
        } catch (err) {
            if (err instanceof NotFoundException) {
                // Return a plain HTML page — tourist's browser sees this, not JSON
                return res.status(404).send(`
          <html>
            <body style="font-family:sans-serif;text-align:center;padding:60px 20px">
              <h2>QR code not recognised</h2>
              <p>Please scan the QR code located in your hotel room.</p>
              <p>If the problem persists, ask hotel reception for assistance.</p>
            </body>
          </html>
        `);
            }
            throw err;
        }
    }

    // ─── Admin: generate rooms + download PDF ────────────────────────────────────

    /**
     * POST /hotels/:hotelId/qr/generate
     *
     * Called once during hotel onboarding to generate all room QR codes.
     * Safe to call again — upserts rooms.
     *
     * Body: { floors: [{ floorNumber: 1, roomCount: 10 }, ...] }
     *
     * Returns the PDF as a binary stream.
     *
     * In Phase 2 this will be behind admin auth middleware.
     * For Phase 1 / demo: protect with a hardcoded admin token in the header
     * or restrict to internal network only (security group level).
     */
    @Post('hotels/:hotelId/qr/generate')
    @HttpCode(200)
    async generateAndDownload(
        @Param('hotelId') hotelId: string,
        @Body() body: { floors: FloorInput[] },
        @Res() res: Response,
    ) {
        if (!body.floors || body.floors.length === 0) {
            return res.status(400).json({ error: 'floors array is required' });
        }

        const result = await this.hotelQrService.generateAndPersistRooms(
            hotelId,
            body.floors,
        );

        this.logger.log(
            `[QRGenerate] hotel=${hotelId} rooms=${result.totalRooms} pdf=${(result.pdfBuffer.length / 1024).toFixed(1)}KB`,
        );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="tma-qr-hotel-${hotelId}.pdf"`,
        );
        res.setHeader('Content-Length', result.pdfBuffer.length);
        return res.send(result.pdfBuffer);
    }

    /**
     * GET /hotels/:hotelId/qr/pdf
     *
     * Re-download the PDF for an existing hotel without regenerating rooms.
     * Useful for re-prints after a hotel calls asking for extra copies.
     */
    @Get('hotels/:hotelId/qr/pdf')
    async downloadExistingPdf(
        @Param('hotelId') hotelId: string,
        @Res() res: Response,
    ) {
        const pdfBuffer = await this.hotelQrService.getPdfForHotel(hotelId);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="tma-qr-hotel-${hotelId}.pdf"`,
        );
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.send(pdfBuffer);
    }
}