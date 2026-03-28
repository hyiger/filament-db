"use client";

import type { ReactNode } from "react";
import NfcProvider from "./NfcProvider";
import NfcReadDialog from "./NfcReadDialog";
import ToastProvider from "./Toast";

export default function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <NfcProvider>
        {children}
        <NfcReadDialog />
      </NfcProvider>
    </ToastProvider>
  );
}
