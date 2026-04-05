"use client";

import type { ReactNode } from "react";
import NfcProvider from "./NfcProvider";
import NfcReadDialog from "./NfcReadDialog";
import ToastProvider from "./Toast";
import { TranslationProvider } from "@/i18n/TranslationProvider";

export default function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <TranslationProvider>
      <ToastProvider>
        <NfcProvider>
          {children}
          <NfcReadDialog />
        </NfcProvider>
      </ToastProvider>
    </TranslationProvider>
  );
}
