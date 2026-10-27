import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';

const BASE_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017';

/**
 * Connects Mongoose to a fresh, uniquely named database for one test file and drops it
 * afterwards. Integration tests run against a real MongoDB (start it with `npm run infra:up`)
 * so that indexes, unique constraints, and queries behave exactly as in production.
 */
export function useTestDatabase(): void {
  beforeAll(async () => {
    const dbName = `aop_test_${randomBytes(4).toString('hex')}`;
    try {
      await mongoose.connect(`${BASE_URI}/${dbName}`, { serverSelectionTimeoutMS: 3000 });
    } catch (error) {
      throw new Error(
        `Integration tests need MongoDB at ${BASE_URI}. Start it with "npm run infra:up". ` +
          `(${(error as Error).message})`,
        { cause: error },
      );
    }
    // Build unique indexes before tests rely on them (e.g. duplicate-email races).
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}
