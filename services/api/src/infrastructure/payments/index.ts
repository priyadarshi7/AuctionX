import { env } from '../../config/env';
import { mockPaymentProvider } from './mockProvider';
import type { PaymentProvider } from './provider';
import { StripePaymentProvider } from './stripeProvider';

// Stripe when a (test-mode) secret key is configured, otherwise the in-process
// mock. config/env.ts has already refused to boot with a live key, so this
// selection can never route real money. Same "configured or fall back" pattern
// as infrastructure/email/sender.ts.
export const paymentProvider: PaymentProvider = env.STRIPE_SECRET_KEY
  ? new StripePaymentProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CURRENCY)
  : mockPaymentProvider;

export { mockPaymentProvider };
export type {
  CreatePaymentIntentInput,
  CreatePaymentIntentResult,
  PaymentProvider,
  PaymentStatusSnapshot,
  PaymentWebhookEvent,
} from './provider';
