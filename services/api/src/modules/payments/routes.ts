import { Router, raw } from 'express';
import { paymentWebhookHandler } from './controller';

export const paymentWebhookRoutes = Router();

// express.raw(), not express.json() — the whole point of this route is
// verifying that the exact bytes received were signed by the provider;
// re-serializing a parsed object would not reproduce those bytes. `type:
// '*/*'` because a webhook's Content-Type is the provider's choice, not
// something we should filter on before we've even verified the signature.
paymentWebhookRoutes.post('/mock', raw({ type: '*/*' }), paymentWebhookHandler);
// Stripe's endpoint (register this URL in the Stripe dashboard). Both paths
// run the same handler: the ACTIVE provider decides how the signature is
// verified, so a mock-signed request to /stripe (or vice versa) is rejected.
paymentWebhookRoutes.post('/stripe', raw({ type: '*/*' }), paymentWebhookHandler);
