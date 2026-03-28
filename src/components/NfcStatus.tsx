"use client";

import { useNfcContext } from "@/components/NfcProvider";

export default function NfcStatus() {
  const { isElectron, status } = useNfcContext();

  if (!isElectron) return null;

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
    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-full text-sm text-gray-300">
      <span className={`w-2 h-2 rounded-full ${dotColor}`} />
      {label}
    </div>
  );
}
