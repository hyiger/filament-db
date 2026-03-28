"use client";

import type { ReactNode } from "react";
import NfcProvider from "./NfcProvider";
import NfcReadDialog from "./NfcReadDialog";

export default function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <NfcProvider>
      {children}
      <NfcReadDialog />
    </NfcProvider>
  );
}
