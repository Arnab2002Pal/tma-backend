import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ClinicService } from './clinic.service';
import { PrismaModule } from '../database/prisma.module';

@Module({
  imports: [
    HttpModule,
    PrismaModule,
  ],
  providers: [ClinicService],
  exports: [ClinicService], // imported by WhatsappModule and BookingModule
})
export class ClinicModule { }