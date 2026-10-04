import { env } from '../../config/env';
import { logger } from '../observability/logger';
import { progressSimulatedShipments } from '../../modules/orders/repository';

// Drives the DEMO courier's tracking timeline (ADR-0045). A real shipping
// aggregator would push these events from its webhook instead; this worker is
// the stand-in for that, because there are no real parcels. It stops at "out
// for delivery": completing delivery needs the buyer's code.
const TICK_MS = 10_000;

let intervalHandle: NodeJS.Timeout | undefined;

// Idempotent and safe on several instances at once (unique (orderId, type)).
export async function runOnce(now: Date = new Date(), stepMs: number = env.SHIPPING_SIM_STEP_SECONDS * 1000): Promise<number> {
  return progressSimulatedShipments(now, stepMs);
}

export function startShipmentSimulatorWorker(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runOnce().catch((err: unknown) => {
      logger.error({ err }, 'Shipment simulator tick failed');
    });
  }, TICK_MS);
  intervalHandle.unref();
}

export function stopShipmentSimulatorWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
