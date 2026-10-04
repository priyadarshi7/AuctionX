// Runs before every test file, after dotenv. Review is off by default in
// tests so the many suites that publish auctions directly keep working
// (ADR-0041); the review tests opt in by setting AUCTION_REVIEW_MODE
// themselves before importing the app.
process.env.AUCTION_REVIEW_MODE = 'off';

// Tests never touch a real payment provider, whatever keys a developer has in
// their local .env (ADR-0044): clearing them selects the in-process mock. The
// Stripe tests build their own provider and fake the module boundary.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
