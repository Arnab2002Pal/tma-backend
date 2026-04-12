import { Module, Global } from '@nestjs/common';
import { RedisProvider } from './redis.provider';
import { RedisService } from './redis.service';

@Global()
@Module({
    providers: [RedisProvider, RedisService],
    exports: [RedisService],
})
export class RedisModule { }