"use client";

import Link from "next/link";
import { useRef, useState } from "react";

export default function SettingsPage() {
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset file input so the same file can be re-selected
    e.target.value = "";

    if (!confirm(
      "This will replace ALL data in the database with the snapshot contents.\n\n" +
      "All current filaments, nozzles, and printers will be deleted.\n\n" +
      "Are you sure?"
    )) return;

    setRestoring(true);
    setRestoreResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/snapshot", { method: "POST", body: formData });
      const data = await res.json();

      if (res.ok) {
        setRestoreResult({
          ok: true,
          message: `Restored ${data.restored.filaments} filaments, ${data.restored.nozzles} nozzles, ${data.restored.printers} printers`,
        });
      } else {
        setRestoreResult({ ok: false, message: data.error || "Restore failed" });
      }
    } catch {
      setRestoreResult({ ok: false, message: "Failed to connect to server" });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; Back to Filaments
        </Link>
      </div>

      <h1 className="text-3xl font-bold mb-2">Settings</h1>
      <p className="text-gray-500 text-sm mb-8">
        Manage your printers, nozzles, and other configuration.
      </p>

      <div className="grid gap-4">
        <Link
          href="/nozzles"
          className="block p-5 rounded-lg border border-gray-700 hover:border-gray-500 hover:bg-gray-900/50 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-200 group-hover:text-white">
                Nozzles
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Manage nozzle sizes available for your printers.
              </p>
            </div>
            <svg className="w-5 h-5 text-gray-600 group-hover:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </div>
        </Link>

        <Link
          href="/printers"
          className="block p-5 rounded-lg border border-gray-700 hover:border-gray-500 hover:bg-gray-900/50 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-200 group-hover:text-white">
                Printers
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Manage your 3D printers and their installed nozzles.
              </p>
            </div>
            <svg className="w-5 h-5 text-gray-600 group-hover:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </div>
        </Link>

        <Link
          href="/api-docs"
          className="block p-5 rounded-lg border border-gray-700 hover:border-gray-500 hover:bg-gray-900/50 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-200 group-hover:text-white">
                API Documentation
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Interactive API reference for all REST endpoints.
              </p>
            </div>
            <svg className="w-5 h-5 text-gray-600 group-hover:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </div>
        </Link>
      </div>

      {/* Database Snapshots */}
      <div className="mt-8 pt-6 border-t border-gray-800">
        <h2 className="text-lg font-semibold text-gray-200 mb-1">Database Snapshots</h2>
        <p className="text-sm text-gray-500 mb-4">
          Download a full backup of all filaments, nozzles, and printers, or restore from a previous snapshot.
        </p>

        <div className="flex gap-3 items-center flex-wrap">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/api/snapshot"
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Download Snapshot
          </a>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleRestore}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={restoring}
            className="px-4 py-2 bg-gray-700 text-white rounded text-sm hover:bg-gray-600 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
            </svg>
            {restoring ? "Restoring..." : "Restore from Snapshot"}
          </button>
        </div>

        {restoreResult && (
          <div className={`mt-3 text-sm px-3 py-2 rounded ${
            restoreResult.ok
              ? "bg-green-900/50 text-green-300 border border-green-800"
              : "bg-red-900/50 text-red-300 border border-red-800"
          }`}>
            {restoreResult.message}
          </div>
        )}
      </div>

      <div className="mt-8 pt-6 border-t border-gray-800">
        <p className="text-xs text-gray-600">
          Filament DB v{process.env.APP_VERSION}
        </p>
      </div>
    </main>
  );
}
