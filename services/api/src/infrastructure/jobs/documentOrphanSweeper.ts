import { logger } from '../observability/logger';
import { prisma } from '../database/prisma';
import { deleteDocumentObjects, listDocumentObjects } from '../storage/documents';

// Garbage-collects objects in the private documents bucket that no database
// row points at. How they arise: an upload that was presigned but never
// registered, a registration refused by the scanner, a delete whose S3 call
// failed, or an account deleted while its cleanup call failed. Harmless but
// private data nobody can see, so it is worth removing.
//
// The age floor is the safety margin: a file uploaded a moment ago is
// legitimately "unregistered" until the seller's next request, and deleting it
// would break that in-flight upload.
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

let intervalHandle: NodeJS.Timeout | undefined;

// Idempotent and safe on several instances at once: deleting an already
// deleted object is a no-op in S3.
export async function runOnce(now: Date = new Date(), minAgeMs: number = ORPHAN_MIN_AGE_MS): Promise<number> {
  const cutoff = now.getTime() - minAgeMs;
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const page = await listDocumentObjects(continuationToken);
    const old = page.objects.filter((o) => o.lastModified !== undefined && o.lastModified.getTime() < cutoff);
    if (old.length > 0) {
      const known = await prisma.auctionDocument.findMany({
        where: { objectKey: { in: old.map((o) => o.key) } },
        select: { objectKey: true },
      });
      const knownKeys = new Set(known.map((k) => k.objectKey));
      const orphans = old.filter((o) => !knownKeys.has(o.key)).map((o) => o.key);
      deleted += await deleteDocumentObjects(orphans);
    }
    continuationToken = page.nextToken;
  } while (continuationToken);

  if (deleted > 0) logger.info({ deleted }, 'documents.orphans_swept');
  return deleted;
}

export function startDocumentOrphanSweeper(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runOnce().catch((err: unknown) => {
      logger.error({ err }, 'Document orphan sweep failed');
    });
  }, SWEEP_INTERVAL_MS);
  // Never keep the process alive just for housekeeping.
  intervalHandle.unref();
}

export function stopDocumentOrphanSweeper(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
