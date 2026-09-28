import { mockPaymentProvider } from './mockProvider';
import type { PaymentProvider } from './provider';

// Only one implementation exists yet — see mockProvider.ts's doc comment
// for why, and how a real StripePaymentProvider would plug in here later,
// selected by env the same way infrastructure/email/sender.ts picks Gmail
// vs. a console fallback by whether GMAIL_USER is configured.
export const paymentProvider: PaymentProvider = mockPaymentProvider;

export { mockPaymentProvider };
export type {
  CreatePaymentIntentInput,
  CreatePaymentIntentResult,
  PaymentProvider,
  PaymentWebhookEvent,
} from './provider';
