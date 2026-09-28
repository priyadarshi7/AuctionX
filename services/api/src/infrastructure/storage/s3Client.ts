import { BucketAlreadyExists, BucketAlreadyOwnedByYou, CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { logger } from '../observability/logger';

// One client for the process, same pattern as the Prisma/Redis singletons —
// not created per request. Works identically against s3mock (local) and
// Cloudflare R2 (production) because both implement the generic S3 API;
// only `endpoint`/`credentials` differ between environments (Section 27/83).
//
// `forcePathStyle: true` is needed for local S3-compatible servers
// (virtual-hosted-style addressing, `bucket.host/key`, needs DNS/wildcard
// setup that a plain `localhost` endpoint doesn't have) and is Cloudflare's
// own documented recommendation for R2 too — so this is the one setting
// that's correct for BOTH targets, not a local-only workaround.
export const s3Client = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

// Called once at server boot (server.ts). Idempotent and best-effort: a
// missing bucket is exactly what a fresh local `docker compose up` produces
// (docker-compose.yml's `s3mock` has no bucket-creation step of its own —
// see its comment for why two earlier approaches that tried to automate
// this at the infrastructure level were both abandoned), so the app
// creating it on demand removes a manual setup step entirely. In
// production the bucket already exists (created once, manually, via R2's
// own dashboard — Section 83's "cloud config is a documented manual step"
// pattern), so this is a harmless no-op there. Never throws: object
// storage being unavailable at boot must not block the app from serving
// unrelated traffic (same reasoning as Redis/email — Section 51/12), only
// image upload itself would fail until it's fixed.
export async function ensureBucketExists(): Promise<void> {
  try {
    await s3Client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    logger.info({ bucket: env.S3_BUCKET }, 'storage.bucket_created');
  } catch (err) {
    if (err instanceof BucketAlreadyOwnedByYou || err instanceof BucketAlreadyExists) {
      return;
    }
    logger.warn({ err, bucket: env.S3_BUCKET }, 'storage.bucket_ensure_failed');
  }
}
