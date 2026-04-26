// src/seed/seed.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class SeedService {
    private readonly logger = new Logger(SeedService.name);

    constructor(private readonly prisma: PrismaService) { }

    // ─── Test Hotel ───────────────────────────────────────────────────────────

    async createTestHotel() {
        const existing = await this.prisma.hotel.findFirst({
            where: { name: 'The Park Kolkata (Test)' },
        });

        if (existing) {
            this.logger.log('[Seed] Test hotel already exists');
            return { message: 'Already exists', hotel: existing };
        }

        const hotel = await this.prisma.hotel.create({
            data: {
                name: 'The Park Kolkata (Test)',
                city: 'kolkata',
                address: '17, Park Street, Kolkata, West Bengal 700016',
                lat: 22.5520,
                lng: 88.3520,
                contactEmail: 'test-hotel@tma.dev',
                // Use your own WhatsApp number here for testing hotel alerts
                contactPhone: '+910000000000',
                totalRooms: 10,
                isActive: true,
                subscriptionActive: false,
            },
        });

        this.logger.log(`[Seed] Test hotel created: ${hotel.id}`);
        return { message: 'Created', hotel };
    }

    // ─── Test Clinics ─────────────────────────────────────────────────────────

    async createTestClinic() {
        const existing = await this.prisma.clinic.findFirst({
            where: { name: 'Apollo Clinic Ballygunge (Test)' },
        });

        if (existing) {
            this.logger.log('[Seed] Test clinic already exists');
            return { message: 'Already exists', clinic: existing };
        }

        const clinics = await this.prisma.clinic.createMany({
            data: [
                // Clinic 1 — ENT + general, close to hotel, Bengali/Hindi/English
                {
                    name: 'Apollo Clinic Ballygunge (Test)',
                    displayName: 'TMA Verified Clinic — South Kolkata',
                    address: '7A, Ballygunge Circular Rd, Kolkata 700019',
                    city: 'kolkata',
                    lat: 22.5246,
                    lng: 88.3639,
                    specialities: ['ent specialist', 'general physician'],
                    languages: ['english', 'hindi', 'bengali'],
                    feeOpd: 50000,   // Rs 500
                    feeNight: 75000, // Rs 750
                    availableHours: { open: 9, close: 21 },
                    isVerified: true,
                    isActive: true,
                    strikeCount: 0,
                    rating: 4.1,
                    completionRate: 0.96,
                    contactPhone: '+910000000001',
                    canProvideTeleconsult: false,
                },
                // Clinic 2 — General physician, slightly further, English only
                {
                    name: 'HealthFirst Clinic Park Street (Test)',
                    displayName: 'TMA Verified Clinic — Central Kolkata',
                    address: '22, Park Street, Kolkata 700016',
                    city: 'kolkata',
                    lat: 22.5514,
                    lng: 88.3512,
                    specialities: ['general physician', 'dermatologist'],
                    languages: ['english', 'hindi'],
                    feeOpd: 40000,   // Rs 400
                    feeNight: 60000, // Rs 600
                    availableHours: { open: 8, close: 22 },
                    isVerified: true,
                    isActive: true,
                    strikeCount: 0,
                    rating: 3.8,
                    completionRate: 0.91,
                    contactPhone: '+910000000002',
                    canProvideTeleconsult: false,
                },
                // Clinic 3 — Orthopaedic + general, Bengali speaking
                {
                    name: 'Mediplus Ortho Gariahat (Test)',
                    displayName: 'TMA Verified Clinic — Gariahat',
                    address: '45, Gariahat Rd, Kolkata 700019',
                    city: 'kolkata',
                    lat: 22.5196,
                    lng: 88.3697,
                    specialities: ['orthopaedic', 'general physician'],
                    languages: ['bengali', 'english'],
                    feeOpd: 60000,   // Rs 600
                    feeNight: 80000, // Rs 800
                    availableHours: { open: 10, close: 20 },
                    isVerified: true,
                    isActive: true,
                    strikeCount: 0,
                    rating: 4.4,
                    completionRate: 0.98,
                    contactPhone: '+910000000003',
                    canProvideTeleconsult: false,
                },
                // Clinic 4 — Gastroenterologist, all languages
                {
                    name: 'CityGut Gastro Clinic (Test)',
                    displayName: 'TMA Verified Clinic — New Alipore',
                    address: '12, New Alipore Rd, Kolkata 700053',
                    city: 'kolkata',
                    lat: 22.5096,
                    lng: 88.3268,
                    specialities: ['gastroenterologist', 'general physician'],
                    languages: ['english', 'hindi', 'bengali'],
                    feeOpd: 70000,   // Rs 700
                    feeNight: 90000, // Rs 900
                    availableHours: { open: 9, close: 21 },
                    isVerified: true,
                    isActive: true,
                    strikeCount: 0,
                    rating: 4.6,
                    completionRate: 0.99,
                    contactPhone: '+910000000004',
                    canProvideTeleconsult: false,
                },
                // Clinic 5 — Dentist, limited hours, English only
                {
                    name: 'SmileCare Dental Jadavpur (Test)',
                    displayName: 'TMA Verified Dental Clinic — Jadavpur',
                    address: '88, Jadavpur Main Rd, Kolkata 700032',
                    city: 'kolkata',
                    lat: 22.4970,
                    lng: 88.3709,
                    specialities: ['dentist'],
                    languages: ['english', 'bengali'],
                    feeOpd: 45000,   // Rs 450
                    feeNight: 65000, // Rs 650
                    availableHours: { open: 10, close: 19 },
                    isVerified: true,
                    isActive: true,
                    strikeCount: 0,
                    rating: 3.9,
                    completionRate: 0.93,
                    contactPhone: '+910000000005',
                    canProvideTeleconsult: false,
                },
            ],
        });

        this.logger.log(`[Seed] Created ${clinics.count} test clinics`);
        return { message: 'Created', count: clinics.count };
    }

    // ─── Seed all ─────────────────────────────────────────────────────────────

    async seedAll() {
        const hotel = await this.createTestHotel();
        const clinics = await this.createTestClinic();
        return { hotel, clinics };
    }

    // ─── Status check ─────────────────────────────────────────────────────────

    async getStatus() {
        const [hotelCount, clinicCount, bookingCount, touristCount] = await Promise.all([
            this.prisma.hotel.count(),
            this.prisma.clinic.count(),
            this.prisma.booking.count(),
            this.prisma.tourist.count(),
        ]);

        return {
            hotels: hotelCount,
            clinics: clinicCount,
            bookings: bookingCount,
            tourists: touristCount,
        };
    }
}