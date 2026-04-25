import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import AppHeader from "@/components/AppHeader";
import ClientProviders from "@/components/ClientProviders";
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
      <head>
        {/* Anti-FOUC: applies the stored theme preference to <html> before
         *  the React tree mounts. Without it, dark-mode users see a
         *  light-flash on every cold load. */}
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInitScript() }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <ClientProviders>
          <AppHeader />
          {children}
        </ClientProviders>
      </body>
    </html>
  );
}
