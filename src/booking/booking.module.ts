import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { PrismaModule } from '../database/prisma.module';
import { RedisModule } from '../session/redis.module';

@Module({
  imports: [PrismaModule, RedisModule],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule { }