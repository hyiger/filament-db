import type { DecodedOpenPrintTag } from './types';

/**
 * A one-shot hand-off for the decoded tag between the scan screen and the
 * create-from-tag confirm screen. expo-router params are strings, and the
 * decoded tag is a nested object the create screen must POST back verbatim as
 * `tagData`, so we stash it in a module ref instead of URL-encoding it.
 *
 * `take` consumes it (read + clear) so a stale scan can't leak into a later,
 * unrelated create flow if the user backs out.
 */
let pending: DecodedOpenPrintTag | null = null;

export function setPendingScan(tag: DecodedOpenPrintTag): void {
  pending = tag;
}

export function takePendingScan(): DecodedOpenPrintTag | null {
  const t = pending;
  pending = null;
  return t;
}
