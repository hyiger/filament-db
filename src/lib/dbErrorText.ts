/**
 * GH #1231: server-side English text for a database-connection failure.
 *
 * The browser translates a `{kind, atlas}` pair itself. API clients that
 * aren't the browser (the mobile app, the slicer forks, curl) and the server
 * log need prose, so this module reads the SAME English strings from the
 * locale file rather than keeping a second copy that could drift. It imports
 * the whole locale file, so keep it out of client bundles: only server code
 * (dbConnect, route handlers) imports it.
 */
import en from "../i18n/locales/en.json";
import {
  dbErrorMessageKey,
  type DbErrorInfo,
  type DbErrorSurface,
} from "./dbErrorKinds";
import {
  classifyMongoConnectionError,
  DbUnavailableError,
} from "./mongoConnectionError";

const EN = en as Record<string, string>;

/** The English hint for a classified failure. Every key exists in en.json
 *  (pinned by tests/dbErrorKinds.test.ts). */
export function describeDbError(info: DbErrorInfo, surface: DbErrorSurface): string {
  return EN[dbErrorMessageKey(info, surface)];
}

/** The error `dbConnect` throws when MONGODB_URI isn't set. */
export function notConfiguredError(): DbUnavailableError {
  const info = { kind: "not-configured" as const, atlas: false };
  return new DbUnavailableError(info, describeDbError(info, "server"));
}

export interface ClassifiedConnectFailure {
  error: DbUnavailableError;
  /** One line for the server log: kind, the deciding code, and the raw
   *  driver message with any connection string redacted. */
  logLine: string;
}

/** Classify a failed connect into the typed error `dbConnect` throws. */
export function toDbUnavailableError(err: unknown, uri: string): ClassifiedConnectFailure {
  const c = classifyMongoConnectionError(err, { uri });
  const error = new DbUnavailableError(c, describeDbError(c, "server"), { cause: err });
  const signal = c.signal ? `, ${c.signal}` : "";
  const target = c.atlas ? " (MongoDB Atlas)" : "";
  return {
    error,
    logLine: `[db] Database connection failed${target}: ${c.kind}${signal}. ${c.detail}`.trim(),
  };
}
