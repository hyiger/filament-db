import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppHeader from "@/components/AppHeader";
import ClientProviders from "@/components/ClientProviders";
import SkipToMain from "@/components/SkipToMain";
import { themeInitScript } from "@/lib/themeInitScript";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Filament DB",
  description: "Manage your 3D printing filament profiles",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Anti-FOUC: applies the stored theme preference to <html> before
         *  the React tree mounts. Without it, dark-mode users see a
         *  light-flash on every cold load.
         *
         *  Plain <script dangerouslySetInnerHTML> instead of next/script's
         *  `beforeInteractive` strategy. In Next 16 + React 19, the
         *  next/script wrapper still tripped React's "Scripts inside React
         *  components are never executed when rendering on the client"
         *  warning on every render — the warning is informational (the
         *  script does execute on SSR) but spammed the browser console
         *  (GH #205). React's rendering of a static <script> with
         *  `dangerouslySetInnerHTML` in the SSR HTML is silent in the
         *  same React-19 path; the browser parses + executes the inline
         *  script during initial paint, which is exactly what the
         *  anti-FOUC pattern needs.
         *
         *  Position: top of <body>, before any of ClientProviders /
         *  AppHeader / children, so the .dark class lands on <html>
         *  before body content paints. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
        <ClientProviders>
          {/* GH #413: Skip-to-content link. Visually hidden until
              focused; appears as a pinned banner when the user tabs
              into the page so they can jump past the 7-link sticky
              nav. Targets `#main-content` (each page's <main> has
              that id). The component lives inside ClientProviders so
              the locale-aware label resolves via `t()`. */}
          <SkipToMain />
          <AppHeader />
          {children}
        </ClientProviders>
      </body>
    </html>
  );
}
