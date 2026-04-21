import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from 'src/database/prisma.service';
import { ClinicAvailableHours, ClinicMatchInput, RankedClinic } from './clinic.types';
import { Clinic } from 'src/generated/prisma/client';

// IST offset in hours
const IST_OFFSET_HOURS = 5.5;

// Ranking weights — must sum to 1.0
const WEIGHTS = {
  distance: 0.40,
  language: 0.30,
  rating: 0.20,
  speciality: 0.10,
} as const;

// Max clinics to return in the WhatsApp list
const MAX_RESULTS = 10;

// Min clinics before expanding to GP fallback
const MIN_RESULTS_BEFORE_FALLBACK = 2;

@Injectable()
export class ClinicService {
  private readonly logger = new Logger(ClinicService.name);
  private readonly mapsApiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.mapsApiKey = this.config.get<string>('GOOGLE_MAPS_API_KEY')!;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Find, rank, and return matching clinics for a triage result.
   * Returns up to MAX_RESULTS ranked clinics.
   * Falls back to general physician if < MIN_RESULTS_BEFORE_FALLBACK found.
   */
  async findMatchingClinics(input: ClinicMatchInput): Promise<RankedClinic[]> {
    const { city, specialityNeeded, detectedLanguage, hotelLat, hotelLng } = input;

    this.logger.log(
      `[ClinicMatch] city=${city} speciality=${specialityNeeded} lang=${detectedLanguage}`,
    );

    // Step 1 — primary query: exact speciality match
    let clinics = await this.queryActiveClinics(city, specialityNeeded);
    let isGpFallback = false;

    // Step 2 — GP fallback if not enough results
    if (clinics.length < MIN_RESULTS_BEFORE_FALLBACK && specialityNeeded !== 'general physician') {
      this.logger.warn(
        `[ClinicMatch] Only ${clinics.length} results for ${specialityNeeded} — expanding to general physician`,
      );
      const gpClinics = await this.queryActiveClinics(city, 'general physician');

      // Merge without duplicates — speciality clinics take priority
      const existingIds = new Set(clinics.map((c) => c.id));
      const additionalGp = gpClinics.filter((c) => !existingIds.has(c.id));
      clinics = [...clinics, ...additionalGp];
      isGpFallback = true;
    }

    if (clinics.length === 0) {
      this.logger.warn(`[ClinicMatch] Zero clinics found for city=${city}`);
      return [];
    }

    // Step 3 — get distances from hotel coordinates via Google Maps
    const distances = await this.getDistances(hotelLat, hotelLng, clinics);

    // Step 4 — compute composite score and rank
    const ranked = clinics
      .map((clinic, idx) => {
        const { distanceKm, distanceText } = distances[idx] ?? {
          distanceKm: 99,
          distanceText: 'Unknown',
        };

        const score = this.computeScore(
          clinic,
          distanceKm,
          detectedLanguage,
          specialityNeeded,
        );

        const matchedSpeciality = clinic.specialities.includes(specialityNeeded)
          ? specialityNeeded
          : 'general physician';

        const gpFallbackForThis =
          isGpFallback && !clinic.specialities.includes(specialityNeeded);

        return {
          id: clinic.id,
          displayName: clinic.displayName,
          distanceKm,
          distanceText,
          speciality: matchedSpeciality,
          languages: clinic.languages,
          feeOpd: clinic.feeOpd,
          feeNight: clinic.feeNight,
          compositeScore: score,
          isGpFallback: gpFallbackForThis,
        } satisfies RankedClinic;
      })
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, MAX_RESULTS);

    this.logger.log(
      `[ClinicMatch] Returning ${ranked.length} clinics. Top: ${ranked[0]?.displayName} (score ${ranked[0]?.compositeScore.toFixed(2)})`,
    );

    return ranked;
  }

  /**
   * Returns true if the current IST time is after-hours
   * i.e. zero or fewer matching clinics would be open right now.
   * Used by whatsapp.service to decide after-hours path before calling findMatchingClinics.
   */
  isAfterHours(): boolean {
    const istHour = this.getCurrentISTHour();
    // Heuristic: if current IST hour is before 8am or after 9pm — after hours
    // Exact per-clinic check happens inside queryActiveClinics via availableHours
    return istHour < 8 || istHour >= 21;
  }

  /**
   * Check if a specific clinic is open right now (IST).
   */
  isClinicOpenNow(clinic: Clinic): boolean {
    const hours = clinic.availableHours as ClinicAvailableHours;
    const istHour = this.getCurrentISTHour();
    return istHour >= hours.open && istHour < hours.close;
  }

  // ─── DB Query ────────────────────────────────────────────────────────────────

  private async queryActiveClinics(city: string, speciality: string): Promise<Clinic[]> {
    const istHour = this.getCurrentISTHour();

    // Fetch active, verified clinics in city with speciality match
    // Open-hours filter done post-query on availableHours JSON
    // (Postgres JSON path filtering on simple { open, close } is cleaner in application layer)
    const clinics = await this.prisma.clinic.findMany({
      where: {
        city: { equals: city, mode: 'insensitive' },
        isActive: true,
        isVerified: true,
        specialities: { has: speciality },
      },
    });

    // Filter by currently open (IST hour within availableHours)
    return clinics.filter((clinic) => {
      const hours = clinic.availableHours as unknown as ClinicAvailableHours;
      return istHour >= hours.open && istHour < hours.close;
    });
  }

  // ─── Google Maps Distance Matrix ─────────────────────────────────────────────

  private async getDistances(
    originLat: number,
    originLng: number,
    clinics: Clinic[],
  ): Promise<Array<{ distanceKm: number; distanceText: string }>> {
    if (clinics.length === 0) return [];

    const destinations = clinics
      .map((c) => `${c.lat},${c.lng}`)
      .join('|');

    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${originLat},${originLng}` +
      `&destinations=${destinations}` +
      `&mode=driving` +
      `&key=${this.mapsApiKey}`;

    try {
      const response = await firstValueFrom(this.httpService.get(url));
      const rows = response.data?.rows?.[0]?.elements ?? [];

      return rows.map((el: any) => {
        if (el.status !== 'OK') {
          return { distanceKm: 99, distanceText: 'Unknown' };
        }
        const distanceKm = el.distance.value / 1000; // metres → km
        const distanceText = el.distance.text;        // e.g. "1.2 km"
        return { distanceKm, distanceText };
      });
    } catch (error) {
      this.logger.error('[ClinicMatch] Google Maps API failed:', error);
      // Fallback: return dummy distances so ranking still works on other signals
      return clinics.map(() => ({ distanceKm: 99, distanceText: 'Unknown' }));
    }
  }

  // ─── Composite Score ─────────────────────────────────────────────────────────

  private computeScore(
    clinic: Clinic,
    distanceKm: number,
    detectedLanguage: string,
    specialityNeeded: string,
  ): number {
    // Distance score — normalised. 0km = 1.0, 10km+ = 0.0
    const distanceScore = Math.max(0, 1 - distanceKm / 10);

    // Language score — exact match = 1.0, partial = 0.5, none = 0.0
    const languageScore = this.computeLanguageScore(clinic.languages, detectedLanguage);

    // Rating score — normalised 0–5 scale
    const ratingScore = clinic.rating / 5;

    // Speciality match score — exact = 1.0, GP fallback = 0.5
    const specialityScore = clinic.specialities.includes(specialityNeeded) ? 1.0 : 0.5;

    const composite =
      WEIGHTS.distance * distanceScore +
      WEIGHTS.language * languageScore +
      WEIGHTS.rating * ratingScore +
      WEIGHTS.speciality * specialityScore;

    return composite;
  }

  private computeLanguageScore(clinicLanguages: string[], detectedLanguage: string): number {
    // Map ISO 639-1 codes to clinic language strings
    const isoToClinicLang: Record<string, string> = {
      en: 'english',
      hi: 'hindi',
      bn: 'bengali',
      fr: 'french',
      de: 'german',
      es: 'spanish',
      ja: 'japanese',
      zh: 'chinese',
      ar: 'arabic',
      ru: 'russian',
      pt: 'portuguese',
      ko: 'korean',
    };

    const mapped = isoToClinicLang[detectedLanguage] ?? detectedLanguage;
    const langs = clinicLanguages.map((l) => l.toLowerCase());

    if (langs.includes(mapped)) return 1.0;

    // Partial match: tourist speaks Hindi, clinic has English — still useful
    // English is the universal fallback — partial credit
    if (langs.includes('english')) return 0.5;

    return 0.0;
  }

  // ─── IST Utilities ───────────────────────────────────────────────────────────

  private getCurrentISTHour(): number {
    const now = new Date();
    // IST = UTC + 5:30
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
    const istMs = utcMs + IST_OFFSET_HOURS * 60 * 60 * 1000;
    return new Date(istMs).getHours();
  }
}