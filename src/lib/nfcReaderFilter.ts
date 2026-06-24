/**
 * Heuristic: does a PC/SC reader name look like a real contactless (NFC)
 * reader, vs a virtual/system or contact-only smart-card "reader" the OS
 * enumerates?
 *
 * GH #847: On Windows 11, the PC/SC stack routinely enumerates readers that
 * aren't NFC hardware at all — virtual smart cards (Windows Hello for Business,
 * UICC/eSIM, TPM) and built-in CONTACT smart-card slots. A virtual/idle card's
 * "present" bit (or a driver phantom) drove a false "Tag detected" in the
 * header and an auto-read popup on a machine with no NFC reader installed.
 *
 * Posture: a DENYLIST, not an allowlist — reject names that clearly identify a
 * virtual/system/contact reader, and let everything else through, so an
 * unlisted-but-real contactless reader still works (an allowlist would risk
 * silently breaking a reader from a vendor we didn't think of). When a real
 * reader is still misidentified, the reader name is surfaced in the NFC status
 * tooltip so it can be reported and a pattern added here.
 *
 * Matching is case-insensitive. `\bcontacted\b` matches the built-in
 * "...Contacted SmartCard..." slots but NOT "contactless".
 */
const NON_CONTACTLESS_READER_PATTERNS: RegExp[] = [
  /virtual smart card/i,
  /windows hello/i,
  /\bUICC\b/i,
  /\bTPM\b/i,
  /\bVSC\b/i,
  /microsoft.*virtual/i,
  /\bcontacted\b/i,
];

export function isLikelyContactlessReader(
  name: string | null | undefined,
): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !NON_CONTACTLESS_READER_PATTERNS.some((re) => re.test(trimmed));
}
