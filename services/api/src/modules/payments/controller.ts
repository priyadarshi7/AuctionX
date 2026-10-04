import type { NextFunction, Request, Response } from 'express';
import { paymentProvider } from '../../infrastructure/payments';
import { handlePaymentWebhook } from './service';

// No authenticate/req.user here on purpose — a payment provider calling
// this endpoint has no session with us at all; its identity IS the
// signature (verified inside handlePaymentWebhook). This route is mounted
// (app.ts) with express.raw(), not express.json() — req.body arrives as a
// Buffer of the exact bytes the provider signed, required for signature
// verification to mean anything (Section 28).
export async function paymentWebhookHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawBody = req.body as Buffer;
    const signatureHeader = req.header(paymentProvider.signatureHeader);
    await handlePaymentWebhook(rawBody, signatureHeader);
    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
}
