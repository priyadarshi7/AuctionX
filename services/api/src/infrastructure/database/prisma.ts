import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env';

// A single shared PrismaClient per process. PrismaClient manages its own
// internal connection pool — creating a new instance per request would open
// a new pool each time and exhaust Postgres's max_connections almost
// immediately under load.
export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
