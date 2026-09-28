import { logger } from '../observability/logger';
import { notifyAuctionChanged } from '../realtime/auctionEvents';
import { closeAuctionIfExpired, findExpiredActiveAuctionIds } from '../../modules/auctions/repository';

// How often the worker scans for expired auctions. Short enough that
// anti-sniping's 30s extensions and typical demo/test auction durations
// close promptly; long enough not to hammer the DB with a scan that, at
// current scale, will almost always find zero candidates.
const SCAN_INTERVAL_MS = 5_000;

let intervalHandle: NodeJS.Timeout | undefined;

// Deliberately no manual "end" HTTP endpoint calls into this — unlike
// cancel, there's no real scenario where a human triggers "determine the
// winner and end this right now" on demand; that's what cancel already
// covers for "stop early, no winner." Ending only ever happens because the
// clock genuinely ran out, which is exactly what this worker checks for.
export async function runOnce(): Promise<void> {
  const now = new Date();
  const candidateIds = await findExpiredActiveAuctionIds(now);

  for (const auctionId of candidateIds) {
    try {
      // Sequential, not Promise.all — each candidate is an independent
      // transaction, and this isn't a hot path (Section 62: don't optimize
      // before there's a measured reason to).
      const result = await closeAuctionIfExpired(auctionId, now);
      if (result.closed) {
        await notifyAuctionChanged(auctionId, 'lifecycle');
        logger.info(
          { auctionId, outcome: result.outcome, winningBidId: result.winningBidId, orderId: result.orderId },
          'auction.closed',
        );
      }
    } catch (err) {
      // One auction failing to close must not stop the rest of the scan —
      // the next tick simply retries it (closing is idempotent by
      // construction: an already-ENDED auction's status check no-ops).
      logger.error({ err, auctionId }, 'Failed to close an expired auction');
    }
  }
}

export function startAuctionClosingWorker(): void {
  if (intervalHandle) {
    return;
  }
  intervalHandle = setInterval(() => {
    void runOnce().catch((err: unknown) => {
      logger.error({ err }, 'Auction closing worker scan failed');
    });
  }, SCAN_INTERVAL_MS);
}

export function stopAuctionClosingWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
