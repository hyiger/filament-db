/**
 * The Server connection screen's "check, then save" sequence, and the rule for
 * when a check's result may still be used. Pure: no React or React Native
 * import, so the root test suite covers it (tests/mobile-checked-save.test.ts).
 *
 * A connection check can take many seconds (a header timeout plus the
 * certificate download). Meanwhile the user can leave the screen with the
 * native back button, come back, and save a different server. The first
 * check's result must then do nothing: no save over the newer one, no
 * navigation on whatever screen is showing, no state set on a screen that is
 * gone. One `CheckedSave` belongs to one mounted screen:
 *
 *  - `dispose()` (the screen unmounted): nothing pending is applied, and no
 *    handler is called again.
 *  - `abandonCheck()` (either field was edited) or a newer `run()`: a pending
 *    check's result is dropped.
 *  - A save that has started is not abandoned — the write is already on its
 *    way — and nothing else starts until it settles.
 */

export type CheckedSavePhase = 'idle' | 'checking' | 'saving';

export type CheckResult<Problem> = { ok: true } | { ok: false; problem: Problem };

export interface CheckedSaveHandlers<Problem> {
  /** The form's lock state. Only ever called for the run that owns it. */
  onPhase(phase: CheckedSavePhase): void;
  /** The check answered and the address does not work. Nothing was saved. */
  onFailed(problem: Problem): void;
  /** Saved, and this run is still the screen's current one. */
  onSaved(): void;
  /** `check` or `save` threw. */
  onError(stage: 'check' | 'save', error: unknown): void;
}

export interface CheckedSaveRun<Problem> {
  /** Null to save without checking ("Save anyway", or clearing the address). */
  check: (() => Promise<CheckResult<Problem>>) | null;
  /** Saves exactly the plan `check` was run for. */
  save: () => Promise<void>;
  on: CheckedSaveHandlers<Problem>;
}

export type CheckedSaveOutcome =
  /** Saved and reported through `onSaved`. */
  | 'saved'
  /** The check failed; reported through `onFailed`. */
  | 'failed'
  /** `check` or `save` threw; reported through `onError`. */
  | 'error'
  /** A newer run or an edit replaced this one before its check answered. */
  | 'superseded'
  /** A save is in flight; this run did not start. */
  | 'busy'
  /** The screen is gone. Nothing was reported. */
  | 'gone';

export interface CheckedSave {
  run<Problem>(run: CheckedSaveRun<Problem>): Promise<CheckedSaveOutcome>;
  /**
   * An edit to the address or the key: drop a pending check's result. True
   * when a check was pending, so the caller unlocks the form. False (and no
   * effect) while a save is in flight or when nothing is pending.
   */
  abandonCheck(): boolean;
  /** The screen unmounted. Final. */
  dispose(): void;
}

export function createCheckedSave(): CheckedSave {
  // Bumped by every run and every abandoned check; a check's result is used
  // only if the number it started with is still this one.
  let generation = 0;
  let checking = false;
  let saving = false;
  let disposed = false;

  return {
    async run({ check, save, on }) {
      // Before anything is sent: the check is what first sends the API key.
      if (disposed) return 'gone';
      if (saving) return 'busy';
      const mine = ++generation;
      // Also clears the flag of a check this run replaces.
      checking = check !== null;

      if (check) {
        on.onPhase('checking');
        let result: Awaited<ReturnType<typeof check>> | null = null;
        let thrown: { error: unknown } | null = null;
        try {
          result = await check();
        } catch (error) {
          thrown = { error };
        }
        if (disposed) return 'gone';
        // Whoever replaced this run owns the form's state now.
        if (mine !== generation) return 'superseded';
        checking = false;
        if (thrown || !result) {
          on.onPhase('idle');
          on.onError('check', thrown?.error);
          return 'error';
        }
        if (!result.ok) {
          on.onPhase('idle');
          on.onFailed(result.problem);
          return 'failed';
        }
      }

      saving = true;
      on.onPhase('saving');
      let thrown: { error: unknown } | null = null;
      try {
        await save();
      } catch (error) {
        thrown = { error };
      }
      saving = false;
      // The write was already under way when the screen went; it stands, but
      // there is no screen left to unlock, tell, or navigate away from.
      if (disposed) return 'gone';
      on.onPhase('idle');
      if (thrown) {
        on.onError('save', thrown.error);
        return 'error';
      }
      on.onSaved();
      return 'saved';
    },

    abandonCheck() {
      if (disposed || saving || !checking) return false;
      generation += 1;
      checking = false;
      return true;
    },

    dispose() {
      disposed = true;
    },
  };
}
