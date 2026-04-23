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
});
