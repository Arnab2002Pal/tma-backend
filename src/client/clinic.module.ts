import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from 'src/database/prisma.module';
import { ClinicService } from './clinic.service';

@Module({
  imports: [
    HttpModule,
    PrismaModule,
  ],
  providers: [ClinicService],
  exports: [ClinicService], // imported by WhatsappModule and BookingModule
})
export class ClinicModule { }