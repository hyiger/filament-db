/**
 * The secure gateway's sign-in page (src/lib/secureGateway.ts).
 *
 * Served by the gateway itself, before authentication, so it is one
 * self-contained document: no scripts, no app assets (those sit behind the
 * sign-in), inline styles only. The app's own translations load client-side
 * after sign-in, so this page carries its few strings and picks the language
 * from `Accept-Language`.
 */

export type LoginLocale = "en" | "de";
export type LoginError = "invalid" | "limited" | null;

const STRINGS: Record<LoginLocale, Record<string, string>> = {
  en: {
    title: "Sign in to Filament DB",
    intro: "This address is protected. Enter the API key to continue.",
    keyLabel: "API key",
    submit: "Sign in",
    hint: "The key is shown in Filament DB under Settings → Network, on the computer or server it runs on.",
    invalid: "That key is not correct.",
    limited: "Too many attempts. Wait {seconds} seconds and try again.",
  },
  de: {
    title: "Bei Filament DB anmelden",
    intro: "Diese Adresse ist geschützt. Geben Sie den API-Schlüssel ein, um fortzufahren.",
    keyLabel: "API-Schlüssel",
    submit: "Anmelden",
    hint: "Der Schlüssel steht in Filament DB unter Einstellungen → Netzwerk, auf dem Computer oder Server, auf dem die App läuft.",
    invalid: "Dieser Schlüssel ist nicht korrekt.",
    limited: "Zu viele Versuche. Warten Sie {seconds} Sekunden und versuchen Sie es erneut.",
  },
};

/** German when it is the first language the browser lists that we have. */
export function loginLocale(acceptLanguage: string | undefined): LoginLocale {
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase();
    if (tag === "de" || tag.startsWith("de-")) return "de";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderLoginPage(options: {
  locale: LoginLocale;
  /** Form target. */
  action: string;
  /** Path to return to after sign-in (already validated by the caller). */
  next: string;
  error: LoginError;
  retryAfterSeconds?: number;
}): string {
  const s = STRINGS[options.locale];
  const message =
    options.error === "invalid"
      ? s.invalid
      : options.error === "limited"
        ? s.limited.replace("{seconds}", String(options.retryAfterSeconds ?? 60))
        : "";
  const alert = message
    ? `<p class="error" role="alert">${escapeHtml(message)}</p>`
    : "";
  return `<!doctype html>
<html lang="${options.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(s.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f3f4f6; color: #111827; }
  main { width: 100%; max-width: 24rem; margin: 1rem; padding: 1.5rem; border-radius: .5rem;
    background: #fff; border: 1px solid #e5e7eb; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; font-size: .875rem; color: #4b5563; }
  label { display: block; font-size: .875rem; font-weight: 600; margin-bottom: .25rem; }
  input[type=password] { box-sizing: border-box; width: 100%; padding: .5rem .75rem; font: inherit;
    border: 1px solid #d1d5db; border-radius: .25rem; background: transparent; color: inherit; }
  button { margin-top: 1rem; width: 100%; padding: .5rem 1rem; font: inherit; font-weight: 600;
    border: 0; border-radius: .25rem; background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .error { color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: .25rem;
    padding: .5rem .75rem; }
  .hint { margin: 1rem 0 0; font-size: .75rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #030712; color: #e5e7eb; }
    main { background: #111827; border-color: #1f2937; }
    p { color: #9ca3af; }
    input[type=password] { border-color: #374151; }
    .error { color: #fca5a5; background: #450a0a; border-color: #7f1d1d; }
  }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(s.title)}</h1>
<p>${escapeHtml(s.intro)}</p>
${alert}
<form method="post" action="${escapeHtml(options.action)}">
<input type="hidden" name="next" value="${escapeHtml(options.next)}">
<input type="text" name="username" value="filament-db" autocomplete="username" hidden>
<label for="key">${escapeHtml(s.keyLabel)}</label>
<input id="key" name="key" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required autofocus>
<button type="submit">${escapeHtml(s.submit)}</button>
</form>
<p class="hint">${escapeHtml(s.hint)}</p>
</main>
</body>
</html>
`;
}
