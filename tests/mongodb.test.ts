import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";

describe("dbConnect", () => {
  beforeEach(() => {
    // Reset the global cache before each test
    (global as Record<string, unknown>).mongoose = undefined;
  });

  it("throws when MONGODB_URI is not defined", async () => {
    const original = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;

    await expect(dbConnect()).rejects.toThrow(
      "Please define the MONGODB_URI environment variable"
    );

    process.env.MONGODB_URI = original;
  });

  it("connects and returns mongoose instance", async () => {
    const result = await dbConnect();
    expect(result).toBeDefined();
    expect(result).toBe(mongoose);
  });

  it("returns cached connection on second call", async () => {
    const first = await dbConnect();
    const second = await dbConnect();
    expect(first).toBe(second);
  });

  it("sets global.mongoose cache", async () => {
    await dbConnect();
    expect((global as Record<string, unknown>).mongoose).toBeDefined();
  });

  it("reuses existing promise when connection is in progress", async () => {
    // Set up a cache with a pending promise but no connection
    const connectPromise = Promise.resolve(mongoose);
    (global as Record<string, unknown>).mongoose = {
      conn: null,
      promise: connectPromise,
    };

    const result = await dbConnect();
    expect(result).toBe(mongoose);
  });

  it("initializes global.mongoose when not set", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect();
    expect((global as Record<string, unknown>).mongoose).toBeDefined();
  });

  it("logs when migration backfills instanceIds", async () => {
    // Connect first to get access to the collection
    await dbConnect();

    // Insert a filament without instanceId directly via collection
    const Filament = mongoose.models.Filament || (await import("@/models/Filament")).default;
    await Filament.collection.insertOne({
      name: "MigrationTest",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      _deletedAt: null,
    });

    // Reset cache to force migration to run again
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    cached.migrated = false;
    cached.conn = null;
    cached.promise = null;

    // Spy on console.log to verify migration message
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dbConnect();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[migration] Backfilled instanceId")
      );
    } finally {
      logSpy.mockRestore();
      // Clean up
      await Filament.deleteMany({ name: "MigrationTest" });
    }
  });


  it("reconnects when URI changes", async () => {
    // First connect with current URI
    await dbConnect();

    // Simulate URI change by modifying the cached URI
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    cached.uri = "mongodb://different-uri:27017/test";

    // This should trigger disconnect and reconnect
    const result = await dbConnect();
    expect(result).toBeDefined();
  });

  it("runs migration on first connect", async () => {
    // Reset cache to force fresh connection
    (global as Record<string, unknown>).mongoose = undefined;

    const result = await dbConnect();
    expect(result).toBeDefined();
    // Migration should have run (cached.migrated = true)
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    expect(cached.migrated).toBe(true);
  });

  it("skips migration on subsequent connects", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect();

    // Second call should skip migration
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    expect(cached.migrated).toBe(true);

    const result = await dbConnect();
    expect(result).toBeDefined();
  });
});
