import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ClinicAvailableHours, ClinicMatchInput, RankedClinic } from './clinic.types';
import { PrismaService } from '../database/prisma.service';
import { Clinic } from '../generated/prisma/client';

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

// Earth radius for Haversine calculation
const EARTH_RADIUS_KM = 6371;

@Injectable()
export class ClinicService {
  private readonly logger = new Logger(ClinicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
  ) { }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Find, rank, and return matching clinics for a triage result.
   * Returns up to MAX_RESULTS ranked clinics.
   * Falls back to general physician if < MIN_RESULTS_BEFORE_FALLBACK found.
   *
   * Distance calculation:
   *   - GOOGLE_MAPS_API_KEY set → Google Maps Distance Matrix (road distance, most accurate)
   *   - GOOGLE_MAPS_API_KEY not set → Haversine formula (straight-line, zero cost, zero dependency)
   *
   * For Kolkata Phase 1 clinic density (all clinics within 5–10km of hotels),
   * Haversine is accurate enough for ranking. Switch to Google Maps at scale.
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

    // Step 3 — get distances (Google Maps if key present, Haversine otherwise)
    const mapsApiKey = this.config.get<string>('GOOGLE_MAPS_API_KEY');
    const distances = mapsApiKey
      ? await this.getGoogleMapsDistances(hotelLat, hotelLng, clinics, mapsApiKey)
      : this.getHaversineDistances(hotelLat, hotelLng, clinics);

    if (!mapsApiKey) {
      this.logger.warn(
        '[ClinicMatch] GOOGLE_MAPS_API_KEY not set — using Haversine straight-line distance',
      );
    }

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
   * Returns true if the current IST time is after-hours.
   * Used by whatsapp.service to decide the after-hours path before calling findMatchingClinics.
   */
  isAfterHours(): boolean {
    const istHour = this.getCurrentISTHour();
    return istHour < 8 || istHour >= 21;
  }

  /**
   * Check if a specific clinic is open right now (IST).
   */
  isClinicOpenNow(clinic: Clinic): boolean {
    const hours = clinic.availableHours as unknown as ClinicAvailableHours;
    const istHour = this.getCurrentISTHour();
    return istHour >= hours.open && istHour < hours.close;
  }

  // ─── DB Query ────────────────────────────────────────────────────────────────

  private async queryActiveClinics(city: string, speciality: string): Promise<Clinic[]> {
    const istHour = this.getCurrentISTHour();

    const clinics = await this.prisma.clinic.findMany({
      where: {
        city: { equals: city, mode: 'insensitive' },
        isActive: true,
        isVerified: true,
        specialities: { has: speciality },
      },
    });

    // Open-hours filter applied in application layer — cleaner than Postgres JSON path query
    return clinics.filter((clinic) => {
      const hours = clinic.availableHours as unknown as ClinicAvailableHours;
      return istHour >= hours.open && istHour < hours.close;
    });
  }

  // ─── Distance: Google Maps Distance Matrix ────────────────────────────────────
  // Used when GOOGLE_MAPS_API_KEY is present.
  // Single batch request — one API call regardless of how many clinics.
  // Returns road distance (most accurate for ranking).
  // On full API failure: falls back to Haversine automatically.

  private async getGoogleMapsDistances(
    originLat: number,
    originLng: number,
    clinics: Clinic[],
    apiKey: string,
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
      `&key=${apiKey}`;

    try {
      const response = await firstValueFrom(this.httpService.get(url));
      const rows = response.data?.rows?.[0]?.elements ?? [];

      return rows.map((el: any, idx: number) => {
        if (el.status !== 'OK') {
          // Individual element failed — use Haversine for this clinic only
          const clinic = clinics[idx];
          const distanceKm = this.haversine(originLat, originLng, clinic.lat, clinic.lng);
          const distanceText = distanceKm < 1
            ? `${Math.round(distanceKm * 1000)}m`
            : `${distanceKm.toFixed(1)} km`;
          return { distanceKm, distanceText };
        }
        const distanceKm = el.distance.value / 1000; // metres → km
        const distanceText = el.distance.text;        // e.g. "1.2 km"
        return { distanceKm, distanceText };
      });
    } catch (error) {
      // Full API failure — fall back to Haversine for all clinics
      // Ranking degrades gracefully: language + rating + speciality still differentiate
      this.logger.error(
        '[ClinicMatch] Google Maps API failed — falling back to Haversine:',
        error,
      );
      return this.getHaversineDistances(originLat, originLng, clinics);
    }
  }

  // ─── Distance: Haversine ─────────────────────────────────────────────────────
  // Used when GOOGLE_MAPS_API_KEY is not set, or as fallback when Google Maps fails.
  // Calculates straight-line (crow-flies) distance in-process.
  // Zero API calls. Zero cost. Zero external dependency.
  // Accurate enough for Kolkata Phase 1 (clinics within 5–10km of hotels).

  private getHaversineDistances(
    originLat: number,
    originLng: number,
    clinics: Clinic[],
  ): Array<{ distanceKm: number; distanceText: string }> {
    return clinics.map((clinic) => {
      const distanceKm = this.haversine(originLat, originLng, clinic.lat, clinic.lng);
      const distanceText = distanceKm < 1
        ? `${Math.round(distanceKm * 1000)}m`
        : `${distanceKm.toFixed(1)} km`;
      return { distanceKm, distanceText };
    });
  }

  /**
   * Haversine formula — great-circle distance between two points on Earth.
   * Returns distance in kilometres.
   */
  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
      Math.cos(this.toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  // ─── Composite Score ─────────────────────────────────────────────────────────

  private computeScore(
    clinic: Clinic,
    distanceKm: number,
    detectedLanguage: string,
    specialityNeeded: string,
  ): number {
    // Distance score — normalised. 0km = 1.0, 10km+ = 0.0, linear between
    const distanceScore = Math.max(0, 1 - distanceKm / 10);

    // Language score — exact match = 1.0, English fallback = 0.5, none = 0.0
    const languageScore = this.computeLanguageScore(clinic.languages, detectedLanguage);

    // Rating score — normalised 0–5 scale. Defaults to 3.0 on Day 1.
    const ratingScore = clinic.rating / 5;

    // Speciality match score — exact = 1.0, GP fallback = 0.5
    const specialityScore = clinic.specialities.includes(specialityNeeded) ? 1.0 : 0.5;

    return (
      WEIGHTS.distance * distanceScore +
      WEIGHTS.language * languageScore +
      WEIGHTS.rating * ratingScore +
      WEIGHTS.speciality * specialityScore
    );
  }

  private computeLanguageScore(clinicLanguages: string[], detectedLanguage: string): number {
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

    // English is the universal fallback — partial credit even if not exact match
    if (langs.includes('english')) return 0.5;

    return 0.0;
  }

  // ─── IST Utilities ───────────────────────────────────────────────────────────

  private getCurrentISTHour(): number {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
    const istMs = utcMs + IST_OFFSET_HOURS * 60 * 60 * 1000;
    return new Date(istMs).getHours();
  }
}