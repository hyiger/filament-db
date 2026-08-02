import { describe, it, expect } from "vitest";
import {
  parseSpoolResponseShape,
  findSpoolById,
  findSpoolByInstanceId,
  INVALID_SHAPE_MESSAGE,
} from "@/lib/spoolResponseShape";

/** GH #1027 — pure helpers behind the spool-mutation routes' ?shape=spool. */
describe("parseSpoolResponseShape", () => {
  it("defaults to 'full' when the param is absent", () => {
    expect(parseSpoolResponseShape(new URLSearchParams(""))).toBe("full");
    expect(parseSpoolResponseShape(new URLSearchParams("other=1"))).toBe("full");
  });

  it("returns 'spool' for shape=spool", () => {
    expect(parseSpoolResponseShape(new URLSearchParams("shape=spool"))).toBe("spool");
  });

  it("returns null (→ 400 at the route) for unrecognized values", () => {
    expect(parseSpoolResponseShape(new URLSearchParams("shape=spol"))).toBeNull();
    expect(parseSpoolResponseShape(new URLSearchParams("shape=full"))).toBeNull();
    expect(parseSpoolResponseShape(new URLSearchParams("shape="))).toBeNull();
    expect(parseSpoolResponseShape(new URLSearchParams("shape=SPOOL"))).toBeNull();
  });

  it("exports a stable 400 message the routes share", () => {
    expect(INVALID_SHAPE_MESSAGE).toContain("spool");
  });
});

describe("findSpoolById", () => {
  // ObjectId-like: findSpoolById must compare via String(), since lean docs
  // carry ObjectId instances, not strings.
  const oid = (hex: string) => ({ toString: () => hex });
  const spools = [
    { _id: oid("aaaaaaaaaaaaaaaaaaaaaaaa"), label: "A" },
    { _id: oid("bbbbbbbbbbbbbbbbbbbbbbbb"), label: "B" },
  ];

  it("finds a spool by stringified _id", () => {
    expect(findSpoolById(spools, "bbbbbbbbbbbbbbbbbbbbbbbb")?.label).toBe("B");
  });

  it("returns null when no spool matches", () => {
    expect(findSpoolById(spools, "cccccccccccccccccccccccc")).toBeNull();
  });

  it("tolerates an absent spools array", () => {
    expect(findSpoolById(undefined, "aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(findSpoolById(null, "aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("works with plain-string _id values too", () => {
    expect(findSpoolById([{ _id: "x1" }], "x1")?._id).toBe("x1");
  });
});

describe("findSpoolByInstanceId", () => {
  const spools = [
    { instanceId: "1086170252", label: "prusa roll" },
    { instanceId: "deadbeef00", label: "auto" },
    { label: "legacy, no id" },
  ];

  it("finds a spool by exact instanceId", () => {
    expect(findSpoolByInstanceId(spools, "deadbeef00")?.label).toBe("auto");
  });

  it("returns null when no spool carries the id", () => {
    expect(findSpoolByInstanceId(spools, "0000000000")).toBeNull();
  });

  it("tolerates an absent spools array", () => {
    expect(findSpoolByInstanceId(undefined, "deadbeef00")).toBeNull();
    expect(findSpoolByInstanceId(null, "deadbeef00")).toBeNull();
  });
});
