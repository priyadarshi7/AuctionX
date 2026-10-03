// Runs before every test file, after dotenv. Review is off by default in
// tests so the many suites that publish auctions directly keep working
// (ADR-0041); the review tests opt in by setting AUCTION_REVIEW_MODE
// themselves before importing the app.
process.env.AUCTION_REVIEW_MODE = 'off';
