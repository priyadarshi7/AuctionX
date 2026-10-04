// The seam between "an order is shipped" and whoever actually moves the parcel
// (ADR-0045), same idea as the payment and email providers. Business logic
// depends only on this interface. Today the only implementation is a
// SIMULATED courier: there are no real parcels in this project, so the carrier
// and tracking number are generated here and the tracking events are produced
// by a worker (infrastructure/jobs/shipmentSimulatorWorker.ts). A real
// aggregator (EasyPost, Shippo, AfterShip) would implement this interface to
// buy a label, and feed events in from its webhook instead of the simulator.

export type CreateShipmentInput = {
  orderId: string;
};

export type CreateShipmentResult = {
  carrier: string;
  trackingNumber: string;
};

export interface ShippingProvider {
  readonly name: string;
  // Must be deterministic per order: shipping an order twice (a retry) must
  // not produce two different tracking numbers.
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
}
