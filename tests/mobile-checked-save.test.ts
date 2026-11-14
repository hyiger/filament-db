import { describe, it, expect } from "vitest";
import {
  createCheckedSave,
  type CheckResult,
  type CheckedSaveHandlers,
} from "../packages/mobile/src/lib/checkedSave";

/**
 * The Server connection screen's check-then-save sequence. A check can take
 * many seconds, and the user can leave the screen, come back and save another
 * server before it answers; these tests pin that a result which is no longer
 * the screen's current one does nothing.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Problem = string;
const OK: CheckResult<Problem> = { ok: true };

/** Records every handler call, in order, as the screen would see them. */
function recorder() {
  const events: string[] = [];
  const on: CheckedSaveHandlers<Problem> = {
    onPhase: (phase) => events.push(`phase:${phase}`),
    onFailed: (problem) => events.push(`failed:${problem}`),
    onSaved: () => events.push("saved"),
    onError: (stage, error) => events.push(`error:${stage}:${(error as Error).message}`),
  };
  return { events, on };
}

/** A stand-in for the stored server config: the last save wins. */
function store() {
  const saves: string[] = [];
  return {
    saves,
    save: (value: string) => async () => {
      saves.push(value);
    },
  };
}

describe("createCheckedSave", () => {
  it("checks, saves and reports, in that order", async () => {
    const flow = createCheckedSave();
    const { events, on } = recorder();
    const db = store();
    const outcome = await flow.run({ check: async () => OK, save: db.save("A"), on });
    expect(outcome).toBe("saved");
    expect(db.saves).toEqual(["A"]);
    expect(events).toEqual(["phase:checking", "phase:saving", "phase:idle", "saved"]);
  });

  it("does not save when the check fails", async () => {
    const flow = createCheckedSave();
    const { events, on } = recorder();
    const db = store();
    const outcome = await flow.run({
      check: async () => ({ ok: false, problem: "untrusted" }),
      save: db.save("A"),
      on,
    });
    expect(outcome).toBe("failed");
    expect(db.saves).toEqual([]);
    expect(events).toEqual(["phase:checking", "phase:idle", "failed:untrusted"]);
  });

  it("saves without checking when there is no check (Save anyway)", async () => {
    const flow = createCheckedSave();
    const { events, on } = recorder();
    const db = store();
    expect(await flow.run({ check: null, save: db.save("A"), on })).toBe("saved");
    expect(db.saves).toEqual(["A"]);
    expect(events).toEqual(["phase:saving", "phase:idle", "saved"]);
  });

  describe("after the screen unmounts", () => {
    it("a check that then passes does not overwrite a server saved since", async () => {
      const db = store();

      // First visit: server A's check is slow.
      const first = createCheckedSave();
      const a = recorder();
      const checkA = deferred<CheckResult<Problem>>();
      const runA = first.run({ check: () => checkA.promise, save: db.save("A"), on: a.on });
      expect(a.events).toEqual(["phase:checking"]);

      // The user goes back, reopens settings and saves server B.
      first.dispose();
      const second = createCheckedSave();
      const b = recorder();
      expect(await second.run({ check: async () => OK, save: db.save("B"), on: b.on })).toBe(
        "saved",
      );

      // Now A's check answers, successfully.
      checkA.resolve(OK);
      expect(await runA).toBe("gone");

      expect(db.saves).toEqual(["B"]);
      // No state set, nothing reported, no navigation from the first screen.
      expect(a.events).toEqual(["phase:checking"]);
    });

    it("a check that then fails or throws reports nothing", async () => {
      for (const settle of [
        (d: Deferred<CheckResult<Problem>>) => d.resolve({ ok: false, problem: "untrusted" }),
        (d: Deferred<CheckResult<Problem>>) => d.reject(new Error("boom")),
      ]) {
        const flow = createCheckedSave();
        const { events, on } = recorder();
        const db = store();
        const check = deferred<CheckResult<Problem>>();
        const run = flow.run({ check: () => check.promise, save: db.save("A"), on });
        flow.dispose();
        settle(check);
        expect(await run).toBe("gone");
        expect(db.saves).toEqual([]);
        expect(events).toEqual(["phase:checking"]);
      }
    });

    it("a save already under way finishes, but nothing is reported or navigated", async () => {
      for (const settle of [
        (d: Deferred<void>) => d.resolve(),
        (d: Deferred<void>) => d.reject(new Error("keychain")),
      ]) {
        const flow = createCheckedSave();
        const { events, on } = recorder();
        const write = deferred<void>();
        const run = flow.run({ check: null, save: () => write.promise, on });
        expect(events).toEqual(["phase:saving"]);
        flow.dispose();
        settle(write);
        expect(await run).toBe("gone");
        expect(events).toEqual(["phase:saving"]);
      }
    });

    it("a new run starts nothing: the check is what first sends the key", async () => {
      const flow = createCheckedSave();
      const { events, on } = recorder();
      const db = store();
      let checks = 0;
      flow.dispose();
      const outcome = await flow.run({
        check: async () => {
          checks += 1;
          return OK;
        },
        save: db.save("A"),
        on,
      });
      expect(outcome).toBe("gone");
      expect(checks).toBe(0);
      expect(db.saves).toEqual([]);
      expect(events).toEqual([]);
      expect(flow.abandonCheck()).toBe(false);
    });
  });

  describe("an edit to the address or the key", () => {
    it("drops a pending check's result, even a passing one", async () => {
      const flow = createCheckedSave();
      const { events, on } = recorder();
      const db = store();
      const check = deferred<CheckResult<Problem>>();
      const run = flow.run({ check: () => check.promise, save: db.save("A"), on });

      // True: a check was pending, so the screen unlocks the form itself.
      expect(flow.abandonCheck()).toBe(true);
      check.resolve(OK);

      expect(await run).toBe("superseded");
      expect(db.saves).toEqual([]);
      expect(events).toEqual(["phase:checking"]);
    });

    it("drops a pending check's failure too", async () => {
      const flow = createCheckedSave();
      const { events, on } = recorder();
      const check = deferred<CheckResult<Problem>>();
      const run = flow.run({ check: () => check.promise, save: async () => {}, on });
      flow.abandonCheck();
      check.resolve({ ok: false, problem: "for the old address" });
      expect(await run).toBe("superseded");
      expect(events).toEqual(["phase:checking"]);
    });

    it("is a no-op when nothing is pending, and the next run works", async () => {
      const flow = createCheckedSave();
      const { events, on } = recorder();
      const db = store();
      expect(flow.abandonCheck()).toBe(false);
      expect(await flow.run({ check: async () => OK, save: db.save("A"), on })).toBe("saved");
      expect(flow.abandonCheck()).toBe(false);
      expect(await flow.run({ check: async () => OK, save: db.save("B"), on })).toBe("saved");
      expect(db.saves).toEqual(["A", "B"]);
      expect(events.filter((e) => e === "saved")).toHaveLength(2);
    });

    it("does not abandon a save that has started", async () => {
      const flow = createCheckedSave();
      const { events, on } = recorder();
      const write = deferred<void>();
      const run = flow.run({ check: null, save: () => write.promise, on });
      expect(flow.abandonCheck()).toBe(false);
      write.resolve();
      expect(await run).toBe("saved");
      expect(events).toEqual(["phase:saving", "phase:idle", "saved"]);
    });
  });

  describe("a newer run", () => {
    it("replaces a pending check; only the newer plan is saved", async () => {
      const flow = createCheckedSave();
      const db = store();
      const a = recorder();
      const b = recorder();
      const checkA = deferred<CheckResult<Problem>>();
      const checkB = deferred<CheckResult<Problem>>();

      const runA = flow.run({ check: () => checkA.promise, save: db.save("A"), on: a.on });
      const runB = flow.run({ check: () => checkB.promise, save: db.save("B"), on: b.on });

      // A answers first and passes: it is no longer the current run.
      checkA.resolve(OK);
      expect(await runA).toBe("superseded");
      expect(db.saves).toEqual([]);
      // It must not unlock the form while B is still checking.
      expect(a.events).toEqual(["phase:checking"]);
      // B's check is still pending, so an edit can still abandon it.
      expect(flow.abandonCheck()).toBe(true);
      checkB.resolve(OK);
      expect(await runB).toBe("superseded");
      expect(db.saves).toEqual([]);
    });

    it("saves the newer plan when its own check passes", async () => {
      const flow = createCheckedSave();
      const db = store();
      const a = recorder();
      const b = recorder();
      const checkA = deferred<CheckResult<Problem>>();
      const runA = flow.run({ check: () => checkA.promise, save: db.save("A"), on: a.on });
      expect(await flow.run({ check: async () => OK, save: db.save("B"), on: b.on })).toBe("saved");
      checkA.resolve(OK);
      expect(await runA).toBe("superseded");
      expect(db.saves).toEqual(["B"]);
      expect(b.events).toEqual(["phase:checking", "phase:saving", "phase:idle", "saved"]);
    });

    it("does not start while a save is in flight", async () => {
      const flow = createCheckedSave();
      const db = store();
      const a = recorder();
      const b = recorder();
      const write = deferred<void>();
      let checks = 0;
      const runA = flow.run({ check: null, save: () => write.promise, on: a.on });
      const outcome = await flow.run({
        check: async () => {
          checks += 1;
          return OK;
        },
        save: db.save("B"),
        on: b.on,
      });
      expect(outcome).toBe("busy");
      expect(checks).toBe(0);
      expect(db.saves).toEqual([]);
      expect(b.events).toEqual([]);
      write.resolve();
      expect(await runA).toBe("saved");
    });

    it("a save-only run clears the check it replaces", async () => {
      const flow = createCheckedSave();
      const db = store();
      const a = recorder();
      const b = recorder();
      const checkA = deferred<CheckResult<Problem>>();
      const runA = flow.run({ check: () => checkA.promise, save: db.save("A"), on: a.on });
      expect(await flow.run({ check: null, save: db.save("B"), on: b.on })).toBe("saved");
      // Nothing is being checked any more, so there is nothing to abandon.
      expect(flow.abandonCheck()).toBe(false);
      checkA.resolve(OK);
      expect(await runA).toBe("superseded");
      expect(db.saves).toEqual(["B"]);
    });
  });

  describe("errors", () => {
    it("reports a check that throws and unlocks the form", async () => {
      const flow = createCheckedSave();
      const { events, on } = recorder();
      const db = store();
      const outcome = await flow.run({
        check: async () => {
          throw new Error("boom");
        },
        save: db.save("A"),
        on,
      });
      expect(outcome).toBe("error");
      expect(db.saves).toEqual([]);
      expect(events).toEqual(["phase:checking", "phase:idle", "error:check:boom"]);
      // The flow is usable again.
      expect(await flow.run({ check: null, save: db.save("A"), on })).toBe("saved");
    });

    it("reports a save that throws, without reporting it saved", async () => {
      const flow = createCheckedSave();
      const { events, on } = recorder();
      const outcome = await flow.run({
        check: async () => OK,
        save: async () => {
          throw new Error("keychain");
        },
        on,
      });
      expect(outcome).toBe("error");
      expect(events).toEqual([
        "phase:checking",
        "phase:saving",
        "phase:idle",
        "error:save:keychain",
      ]);
      // A failed save no longer blocks the next one.
      const db = store();
      expect(await flow.run({ check: null, save: db.save("A"), on })).toBe("saved");
    });
  });
});
