// prisma.config.ts
import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';

config(); // This loads the .env file

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
