import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

describe("SharedCatalog Model", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SharedCatalog: any;

  beforeEach(async () => {
    delete mongoose.models.SharedCatalog;
    SharedCatalog = (await import("@/models/SharedCatalog")).default;
    await SharedCatalog.syncIndexes();
  });

  it("auto-generates a unique slug on create", async () => {
    const a = await SharedCatalog.create({
      title: "A",
      payload: { version: 1, createdAt: "", filaments: [], nozzles: [], printers: [], bedTypes: [] },
    });
    const b = await SharedCatalog.create({
      title: "B",
      payload: { version: 1, createdAt: "", filaments: [], nozzles: [], printers: [], bedTypes: [] },
    });
    expect(a.slug).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.slug).not.toBe(b.slug);
    // Length is 12 base64url characters before any padding stripping
    expect(a.slug.length).toBeGreaterThanOrEqual(10);
  });

  it("defaults viewCount to zero", async () => {
    const c = await SharedCatalog.create({
      title: "Test",
      payload: { version: 1, createdAt: "", filaments: [], nozzles: [], printers: [], bedTypes: [] },
    });
    expect(c.viewCount).toBe(0);
  });

  it("rejects duplicate slugs", async () => {
    const slug = "fixed-slug-for-test";
    await SharedCatalog.create({
      slug,
      title: "First",
      payload: { version: 1, createdAt: "", filaments: [], nozzles: [], printers: [], bedTypes: [] },
    });
    await expect(
      SharedCatalog.create({
        slug,
        title: "Second",
        payload: { version: 1, createdAt: "", filaments: [], nozzles: [], printers: [], bedTypes: [] },
      }),
    ).rejects.toThrow();
  });

  it("requires title and payload", async () => {
    await expect(SharedCatalog.create({})).rejects.toThrow();
  });

  it("syncIndexes() upgrades a legacy non-partial slug index to the partial-on-_deletedAt one", async () => {
    // Codex round-3 P2: existing installs already have the prior plain
    // unique-on-slug index from earlier schema versions; createIndex()
    // won't mutate options in-place, so the soft-delete republish flow
    // would still trip on the old global-uniqueness rule. The migration
    // in src/lib/mongodb.ts calls SharedCatalog.syncIndexes() to drop
    // any incompatible existing index and recreate. Simulate the
    // upgrade scenario: drop the model's index, install the legacy one
    // by hand, then re-run syncIndexes and assert the result.
    const col = SharedCatalog.collection;
    await col.dropIndex("slug_1").catch(() => {});
    await col.createIndex({ slug: 1 }, { unique: true, name: "slug_1" });

    const before = await col.indexes();
    const beforeSlug = before.find((i: { name?: string }) => i.name === "slug_1");
    expect(beforeSlug).toBeDefined();
    expect(beforeSlug?.partialFilterExpression).toBeUndefined();

    const dropped = await SharedCatalog.syncIndexes();
    expect(dropped).toContain("slug_1");

    const after = await col.indexes();
    const afterSlug = after.find((i: { name?: string }) => i.name === "slug_1");
    expect(afterSlug).toBeDefined();
    expect(afterSlug?.partialFilterExpression).toEqual({ _deletedAt: null });

    // Republish-after-unpublish now works: a slug used by a tombstoned
    // row can be re-minted without tripping the unique index.
    const seed = await SharedCatalog.create({
      slug: "reused",
      title: "Original",
      payload: { version: 1, createdAt: "", filaments: [], nozzles: [], printers: [], bedTypes: [] },
    });
    await SharedCatalog.updateOne({ _id: seed._id }, { $set: { _deletedAt: new Date() } });
    await expect(
      SharedCatalog.create({
        slug: "reused",
        title: "Re-published",
        payload: { version: 1, createdAt: "", filaments: [], nozzles: [], printers: [], bedTypes: [] },
      }),
    ).resolves.toBeDefined();
  });
});
