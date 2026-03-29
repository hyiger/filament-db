"use client";

import { useState, useEffect } from "react";
import { useNfcContext } from "@/components/NfcProvider";

export default function NfcStatus() {
  const { isElectron, status } = useNfcContext();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — only render after client mount
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !isElectron) return null;

  let dotColor: string;
  let label: string;

  if (!status.readerConnected) {
    dotColor = "bg-gray-500";
    label = "No NFC reader";
  } else if (!status.tagPresent) {
    dotColor = "bg-yellow-400";
    label = "Ready — place tag";
  } else {
    dotColor = "bg-green-400";
    label = `Tag detected${status.tagUid ? ` (${status.tagUid.slice(-8).toUpperCase()})` : ""}`;
  }

  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-800 border border-gray-700 rounded-full text-xs text-gray-300">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      {label}
    </div>
  );
}
