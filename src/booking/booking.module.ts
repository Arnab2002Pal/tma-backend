import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { RedisModule } from 'src/session/redis.module';
import { PrismaModule } from 'src/database/prisma.module';

@Module({
  imports: [PrismaModule, RedisModule],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule { }