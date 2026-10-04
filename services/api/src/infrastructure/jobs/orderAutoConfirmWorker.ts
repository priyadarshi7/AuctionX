import { env } from '../../config/env';
import { logger } from '../observability/logger';
import { autoConfirmDelivery, findStaleShippedOrderIds } from '../../modules/orders/repository';

// The fallback for the delivery code (ADR-0045): a SHIPPED order that nobody
// completed within ORDER_AUTO_CONFIRM_DAYS is marked delivered, so a lost code
// or a silent buyer cannot leave an order stuck forever. Days-long deadline,
// so an hourly check is plenty.
const SCAN_INTERVAL_MS = 60 * 60 * 1000;

let intervalHandle: NodeJS.Timeout | undefined;

// Idempotent and safe on several instances at once: the confirmation is a
// guarded UPDATE, so exactly one caller transitions each order.
export async function runOnce(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.ORDER_AUTO_CONFIRM_DAYS * 24 * 60 * 60 * 1000);
  let confirmed = 0;
  for (const orderId of await findStaleShippedOrderIds(cutoff)) {
    try {
      if (await autoConfirmDelivery(orderId, cutoff)) {
        confirmed += 1;
        logger.info({ orderId }, 'order.delivery_auto_confirmed');
      }
    } catch (err) {
      logger.error({ err, orderId }, 'Failed to auto-confirm a delivery');
    }
  }
  return confirmed;
}

export function startOrderAutoConfirmWorker(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runOnce().catch((err: unknown) => {
      logger.error({ err }, 'Order auto-confirm scan failed');
    });
  }, SCAN_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopOrderAutoConfirmWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
