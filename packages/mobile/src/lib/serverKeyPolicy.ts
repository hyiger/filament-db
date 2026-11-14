import {
  INVALID_ADDRESS_MESSAGE,
  normalizeServerAddress,
  parseServerAddress,
  sameServer,
} from './serverAddress';

/**
 * Which API key may go to which server. Pure: the Server connection screen
 * renders what these functions decide and sends nothing they did not allow
 * (tests/mobile-server-key-policy.test.ts).
 *
 * The rule: **a saved key belongs to the server it was saved for** — the same
 * scheme, host and port. The screen used to seed its key field from the saved
 * key and keep it whatever happened to the address, so tapping a discovered
 * server and pressing Save sent the old server's key to the new address. A
 * discovered address comes from mDNS, which anything on the network can
 * answer, and an `http://` one would have received the key unencrypted.
 */

export interface StoredConnection {
  baseUrl: string | null;
  apiKey: string | null;
}

export interface KeyFieldState {
  /** What the API key field holds. */
  value: string;
  /** True when a saved key exists but is being kept back because the address
   *  now names a different server. The screen says so next to the field. */
  withheld: boolean;
}

/**
 * The API key field's content for the address currently in the form.
 *
 * `typedKey` is null until the user edits the key field in this visit to the
 * screen; from then on what they typed is the field's content, for whatever
 * address they end up saving. Until then the field shows the SAVED key only
 * while the address still names the server it was saved for, and is empty
 * otherwise — computed from the address, so editing the address back restores
 * it and no half-typed address can leak it.
 */
export function keyFieldState(input: {
  stored: StoredConnection;
  address: string;
  typedKey: string | null;
}): KeyFieldState {
  const { stored, address, typedKey } = input;
  if (typedKey !== null) return { value: typedKey, withheld: false };
  const savedKey = stored.apiKey ?? '';
  if (savedKey === '') return { value: '', withheld: false };
  if (sameServer(address, stored.baseUrl)) return { value: savedKey, withheld: false };
  // A blank address is "not connected", not "a different server".
  return { value: '', withheld: normalizeServerAddress(address) !== null };
}

/**
 * Why saving would send the key unencrypted, when it would:
 * - `discovered`: the address is one mDNS offered, with no `tls=1` record.
 *   Nothing proves who answered that scan.
 * - `manual`: the user typed an `http://` address themselves (a desktop older
 *   than the secure gateway that sets FILAMENTDB_API_KEY).
 */
export type CleartextKeyRisk = 'discovered' | 'manual';

export type SavePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      baseUrl: string | null;
      apiKey: string | null;
      /** The address names a different server than the saved one. */
      serverChanged: boolean;
      /** Non-null when the user must confirm before the key is sent or saved. */
      cleartextKey: CleartextKeyRisk | null;
    };

/**
 * Decide what pressing Save does. Nothing is sent and nothing is stored until
 * this returns `ok`, and when `cleartextKey` is set, not until the user has
 * confirmed.
 *
 * `key` is the key field's content as `keyFieldState` computed it, so a saved
 * key that was withheld arrives here as an empty string.
 */
export function planSave(input: {
  stored: StoredConnection;
  address: string;
  key: string;
  /** Addresses the network scan offered while this screen was open. */
  discoveredUrls?: readonly string[];
}): SavePlan {
  const { stored } = input;
  const baseUrl = normalizeServerAddress(input.address);
  if (baseUrl === null) {
    // No server: there is nothing a key could belong to.
    return {
      ok: true,
      baseUrl: null,
      apiKey: null,
      serverChanged: stored.baseUrl !== null,
      cleartextKey: null,
    };
  }
  const parsed = parseServerAddress(baseUrl);
  if (!parsed) return { ok: false, error: INVALID_ADDRESS_MESSAGE };

  const apiKey = input.key.trim() || null;
  const serverChanged = !sameServer(baseUrl, stored.baseUrl);

  let cleartextKey: CleartextKeyRisk | null = null;
  // An http:// address with a key that is already saved for it is the existing
  // arrangement, not a new decision; anything else is asked once.
  const alreadyInUse = !serverChanged && apiKey === (stored.apiKey ?? null);
  if (parsed.scheme === 'http' && apiKey !== null && !alreadyInUse) {
    const discovered = (input.discoveredUrls ?? []).some((url) => sameServer(url, baseUrl));
    cleartextKey = discovered ? 'discovered' : 'manual';
  }

  return { ok: true, baseUrl, apiKey, serverChanged, cleartextKey };
}

/** The confirmation shown before a key goes to an `http://` address. */
export function cleartextKeyWarning(risk: CleartextKeyRisk, baseUrl: string): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  const title = 'Send the API key unencrypted?';
  const confirmLabel = 'Send unencrypted';
  if (risk === 'discovered') {
    return {
      title,
      confirmLabel,
      message:
        `${baseUrl} was found by scanning the network and did not announce a secure (https) ` +
        `connection. Anything on this network can answer that scan, and the key would be ` +
        `readable by anyone who can see this network's traffic. A desktop sharing through its ` +
        `secure gateway is listed as "Secure" with an https:// address. Only continue if you ` +
        `know this is your own, older Filament DB.`,
    };
  }
  return {
    title,
    confirmLabel,
    message:
      `${baseUrl} is not encrypted, so the key would be readable by anyone who can see this ` +
      `network's traffic. A current Filament DB desktop shows an https:// address under ` +
      `Settings → Network. Only continue for an older Filament DB on a network you trust.`,
  };
}
