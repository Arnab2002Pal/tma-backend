import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return '[TEST API] Welcome to Tripal Care: Travel with a Pal who cares!';
  }
}
