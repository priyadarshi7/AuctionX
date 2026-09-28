import { Router, raw } from 'express';
import { paymentWebhookHandler } from './controller';

export const paymentWebhookRoutes = Router();

// express.raw(), not express.json() — the whole point of this route is
// verifying that the exact bytes received were signed by the provider;
// re-serializing a parsed object would not reproduce those bytes. `type:
// '*/*'` because a webhook's Content-Type is the provider's choice, not
// something we should filter on before we've even verified the signature.
paymentWebhookRoutes.post('/mock', raw({ type: '*/*' }), paymentWebhookHandler);
