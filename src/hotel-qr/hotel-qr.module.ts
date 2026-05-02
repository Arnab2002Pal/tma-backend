// src/hotel-qr/hotel-qr.module.ts

import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HotelQrController } from './hotel-qr.controller';
import { HotelQrService } from './hotel-qr.service';
import { QrService } from './qr.service';

@Module({
    imports: [HttpModule],
    controllers: [HotelQrController],
    providers: [HotelQrService, QrService],
    exports: [HotelQrService],   // exported so SeedModule can call generateAndPersistRooms
})
export class HotelQrModule { }