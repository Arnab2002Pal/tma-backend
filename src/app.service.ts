import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Welcome to Tripal Care: Travel with a Pal who cares!';
  }
}
