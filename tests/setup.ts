import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { beforeAll, afterAll, afterEach } from "vitest";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].drop().catch(() => {});
  }
  // Clear cached models so schemas are fresh each test
  for (const modelName of Object.keys(mongoose.models)) {
    delete mongoose.models[modelName];
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
