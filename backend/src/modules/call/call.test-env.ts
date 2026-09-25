// Test-only: makes `lib/jwt` importable without a real secret. Imported first by route tests.
process.env.JWT_SECRET ||= "unit-test-secret-not-a-real-secret";
