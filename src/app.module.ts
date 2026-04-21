import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ConfigModule } from '@nestjs/config';
import { TriageModule } from './triage/triage.module';
import { RedisModule } from './session/redis.module';
import { PrismaService } from './database/prisma.service';
import { PrismaModule } from './database/prisma.module';
import { ClinicModule } from './client/clinic.module';
import { BookingModule } from './booking/booking.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env'
    }),
    WhatsappModule,
    TriageModule,
    RedisModule,
    PrismaModule,
    ClinicModule,
    BookingModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
