/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  clearMocks: true,
  // Loads services/api/.env so env.ts's fail-fast validation sees
  // DATABASE_URL. Tests currently run against the same local Postgres as
  // dev — a separate, isolated test database (Testcontainers) is a later
  // Testing-phase concern (Section 36), not needed for schema-level tests yet.
  setupFiles: ['dotenv/config'],
  // afterAll (needs Jest's test framework, unlike setupFiles above which
  // runs before it exists) — closes each file's Prisma/Redis connections.
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.ts'],
};
