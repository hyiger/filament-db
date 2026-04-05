/**
 * Extract the spoolData JSON object from a Prusament spool HTML page.
 *
 * The data is embedded as: var spoolData = '{...}'; or var spoolData = "{...}";
 * Returns null if no spoolData is found.
 */
export function extractSpoolData(html: string): Record<string, unknown> | null {
  const match =
    html.match(/var\s+spoolData\s*=\s*'({[\s\S]*?})'\s*;/) ??
    html.match(/var\s+spoolData\s*=\s*"({[\s\S]*?})"\s*;/);
  if (!match) return null;
  return JSON.parse(match[1]);
}
