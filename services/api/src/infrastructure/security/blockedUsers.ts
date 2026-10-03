import { redis } from '../redis/client';
import { logger } from '../observability/logger';
import { ACCESS_TOKEN_TTL_SECONDS } from './tokens';

// Closes the stateless-JWT gap: a banned or suspended user's access token
// would otherwise keep working until it expires (up to 15 minutes). When an
// admin restricts an account we write a marker that outlives any token issued
// before the change; `authenticate` rejects requests from a marked user.
//
//   Key:            user:blocked:{userId}
//   Value:          '1'
//   TTL:            access-token lifetime + 60s margin (after that every
//                   pre-ban token has expired, and login re-checks the DB)
//   Source of truth: users.status in PostgreSQL
//   Invalidation:   deleted when the account is reactivated, else TTL
//   Failure:        Redis down -> FAIL OPEN (the request proceeds). Redis is
//                   never load-bearing; the bid and listing paths still
//                   re-check status in PostgreSQL, so money paths stay closed.
const KEY = (userId: string) => `user:blocked:${userId}`;
const TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS + 60;

export async function markUserBlocked(userId: string): Promise<void> {
  try {
    await redis.set(KEY(userId), '1', 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, userId }, 'Could not mark user as blocked in Redis; relying on DB status checks');
  }
}

export async function clearUserBlocked(userId: string): Promise<void> {
  try {
    await redis.del(KEY(userId));
  } catch (err) {
    logger.warn({ err, userId }, 'Could not clear blocked marker in Redis; it will expire on its own');
  }
}

export async function isUserBlocked(userId: string): Promise<boolean> {
  try {
    return (await redis.exists(KEY(userId))) === 1;
  } catch {
    return false;
  }
}
