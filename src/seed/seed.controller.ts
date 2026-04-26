// src/seed/seed.controller.ts
import { Controller, Post, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { SeedService } from './seed.service';

// ⚠️  DEV ONLY — remove or guard with NODE_ENV check before production
@Controller('seed')
export class SeedController {
  constructor(private readonly seedService: SeedService) { }

  @Post('hotel')
  @HttpCode(HttpStatus.CREATED)
  async seedHotel() {
    return this.seedService.createTestHotel();
  }

  @Post('clinic')
  @HttpCode(HttpStatus.CREATED)
  async seedClinic() {
    return this.seedService.createTestClinic();
  }

  @Post('all')
  @HttpCode(HttpStatus.CREATED)
  async seedAll() {
    return this.seedService.seedAll();
  }

  @Get('status')
  async status() {
    return this.seedService.getStatus();
  }
}