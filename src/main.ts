import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3000;

  /**
   * Global handler for unhandled promise rejections.
   * 1. Suppresses specific gRPC errors caused by missing Google Cloud credentials.
   *    This is expected when the system falls back to the local Whisper model.
   * 2. Logs other critical errors to the console.
   * 3. Prevents the process from exiting to ensure the WhatsApp webhook listener
   *    remains active even if a specific task fails.
   */
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const msg: string = reason?.message ?? String(reason);
    // gRPC credential errors from Google STT lazy init — expected when GCP creds absent
    if (msg.includes('Could not load the default credentials')) {
      console.warn(
        '[main] Swallowed gRPC credential rejection (Google STT unavailable — Whisper active)',
      );
      return;
    }
    console.error('[main] Unhandled promise rejection:', reason);
    // Do NOT crash — keep the process alive for WhatsApp webhook delivery
  });

  await app.listen(port);
  console.log(`App running at port: ${port}`);
}

void bootstrap();
