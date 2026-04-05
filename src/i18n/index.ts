export type Locale = "en" | "de";

export const LOCALES: { code: Locale; name: string; nativeName: string }[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "de", name: "German", nativeName: "Deutsch" },
];

export const DEFAULT_LOCALE: Locale = "en";
