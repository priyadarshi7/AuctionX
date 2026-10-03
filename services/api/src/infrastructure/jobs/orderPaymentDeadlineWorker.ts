import { logger } from '../observability/logger';
import { IN_FLIGHT_PAYMENT_GRACE_MS } from '../../modules/orders/lifecycle';
import { cancelOverdueUnpaidOrder, findOverdueUnpaidOrderIds } from '../../modules/orders/repository';

// Deadlines are 48h long, so a minute's granularity is plenty — unlike the
// auction closing worker (5s), nobody is watching a clock tick down here.
const SCAN_INTERVAL_MS = 60_000;

let intervalHandle: NodeJS.Timeout | undefined;

// Idempotent and safe to run on several instances at once: the cancel is a
// guarded UPDATE (orders/repository.ts), so whichever instance gets there
// first wins and the rest match nothing. One order failing must not stop the
// rest of the scan; the next tick simply retries it.
export async function runOnce(now: Date = new Date()): Promise<void> {
  const inFlightCutoff = new Date(now.getTime() - IN_FLIGHT_PAYMENT_GRACE_MS);
  const candidateIds = await findOverdueUnpaidOrderIds(now);

  for (const orderId of candidateIds) {
    try {
      if (await cancelOverdueUnpaidOrder(orderId, now, inFlightCutoff)) {
        logger.info({ orderId }, 'order.cancelled_payment_timeout');
      }
    } catch (err) {
      logger.error({ err, orderId }, 'Failed to cancel an overdue unpaid order');
    }
  }
}

export function startOrderPaymentDeadlineWorker(): void {
  if (intervalHandle) {
    return;
  }
  intervalHandle = setInterval(() => {
    void runOnce().catch((err: unknown) => {
      logger.error({ err }, 'Order payment deadline worker scan failed');
    });
  }, SCAN_INTERVAL_MS);
}

export function stopOrderPaymentDeadlineWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
