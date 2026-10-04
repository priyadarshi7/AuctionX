import { createHash } from 'node:crypto';
import type { CreateShipmentInput, CreateShipmentResult, ShippingProvider } from './provider';

// A pretend courier. Clearly labelled as such in the carrier name, so nobody
// mistakes a demo tracking number for a real one. The number is derived from
// the order id, which makes createShipment deterministic (see the interface).
class SimulatedCourier implements ShippingProvider {
  readonly name = 'simulated';

  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const digits = BigInt('0x' + createHash('sha256').update(input.orderId).digest('hex').slice(0, 16))
      .toString()
      .padStart(12, '0')
      .slice(0, 12);
    return Promise.resolve({ carrier: 'AuctionX Express (demo courier)', trackingNumber: `AX${digits}` });
  }
}

export const shippingProvider: ShippingProvider = new SimulatedCourier();
export type { ShippingProvider } from './provider';
