"use client";

import { useEffect, useRef, useState } from "react";

interface RemoteFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
  parentId?: string;
  temperatures?: { nozzle?: number; bed?: number };
}

interface Props {
  onClose: () => void;
  onImported: (message: string) => void;
}

type Step = "connect" | "select" | "confirm" | "importing";

export default function ImportAtlasDialog({ onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>("connect");
  const [uri, setUri] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [filaments, setFilaments] = useState<RemoteFilament[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importProgress, setImportProgress] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap
  useEffect(() => {
    if (!dialogRef.current) return;
    dialogRef.current.focus();

    const dialog = dialogRef.current;
    const handleTab = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || document.activeElement === dialog) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleTab);
    return () => document.removeEventListener("keydown", handleTab);
  }, [onClose]);

  const handleConnect = async () => {
    if (!uri.trim()) return;
    setConnecting(true);
    setError("");
    try {
      const res = await fetch("/api/filaments/import-atlas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Connection failed");
        setConnecting(false);
        return;
      }
      setFilaments(data.filaments || []);
      setSelected(new Set((data.filaments || []).map((f: RemoteFilament) => f._id)));
      setStep("select");
    } catch {
      setError("Network error");
    } finally {
      setConnecting(false);
    }
  };

  const toggleAll = () => {
    if (selected.size === filaments.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filaments.map((f) => f._id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleImport = async () => {
    setStep("importing");
    setImportProgress("Importing...");
    setError("");
    try {
      const res = await fetch("/api/filaments/import-atlas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri, filamentIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Import failed");
        setImportProgress("");
        setStep("select");
        return;
      }
      onImported(data.message);
    } catch {
      setError("Network error during import");
      setImportProgress("");
      setStep("select");
    }
  };

  const parentCount = filaments.filter((f) => !f.parentId).length;
  const variantCount = filaments.filter((f) => f.parentId).length;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60" onClick={step !== "importing" ? onClose : undefined} />
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="atlas-dialog-title"
          tabIndex={-1}
          className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-w-lg w-full mx-4 pointer-events-auto outline-none flex flex-col max-h-[85vh]"
        >
          {/* Header */}
          <div className="p-6 pb-0">
            <h2 id="atlas-dialog-title" className="text-lg font-bold text-white mb-1">
              {step === "connect" && "Import from MongoDB Atlas"}
              {step === "select" && "Select Filaments to Import"}
              {step === "confirm" && "Confirm Import"}
              {step === "importing" && "Importing..."}
            </h2>
          </div>

          {/* Content */}
          <div className="p-6 flex-1 overflow-y-auto">
            {/* Step 1: Connection string */}
            {step === "connect" && (
              <>
                <p className="text-sm text-gray-400 mb-4">
                  Enter a MongoDB Atlas connection string to browse and import filaments from another database.
                </p>
                <input
                  type="password"
                  className="w-full px-3 py-2 border border-gray-600 rounded text-sm bg-transparent text-gray-100 mb-3"
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                  placeholder="mongodb+srv://user:pass@cluster.mongodb.net/"
                  onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
                  autoFocus
                />
                {error && (
                  <div className="p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300 mb-3">
                    {error}
                  </div>
                )}
              </>
            )}

            {/* Step 2: Select filaments */}
            {step === "select" && (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-gray-400">
                    {filaments.length} filament{filaments.length !== 1 ? "s" : ""} found
                    {variantCount > 0 && ` (${parentCount} base, ${variantCount} variant${variantCount !== 1 ? "s" : ""})`}
                  </span>
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    {selected.size === filaments.length ? "Deselect All" : "Select All"}
                  </button>
                </div>
                {error && (
                  <div className="p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300 mb-3">
                    {error}
                  </div>
                )}
                <ul className="space-y-1 max-h-[50vh] overflow-y-auto">
                  {filaments.map((f) => (
                    <li key={f._id}>
                      <label className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-800 cursor-pointer text-sm">
                        <input
                          type="checkbox"
                          checked={selected.has(f._id)}
                          onChange={() => toggleOne(f._id)}
                          className="w-4 h-4 rounded"
                        />
                        <div
                          className="w-4 h-4 rounded-full border border-gray-500 flex-shrink-0"
                          style={{ backgroundColor: f.color || "#808080" }}
                        />
                        <span className={`flex-1 truncate ${f.parentId ? "text-gray-400 pl-3" : "text-white"}`}>
                          {f.parentId && <span className="text-gray-600 mr-1">↳</span>}
                          {f.name}
                        </span>
                        <span className="text-gray-500 text-xs flex-shrink-0">
                          {f.vendor} · {f.type}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* Step 3: Confirm */}
            {step === "confirm" && (
              <div className="text-sm text-gray-300">
                <p className="mb-4">
                  Import <strong className="text-white">{selected.size}</strong> filament{selected.size !== 1 ? "s" : ""} into your local database?
                </p>
                <p className="text-gray-500">
                  Existing filaments with the same name will be updated. New filaments will be created. Parent-variant relationships will not be preserved.
                </p>
              </div>
            )}

            {/* Step 4: Importing */}
            {step === "importing" && (
              <div className="flex items-center gap-3 text-sm text-gray-300">
                <svg className="w-5 h-5 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>{importProgress}</span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-6 pt-0 flex justify-end gap-3">
            {step === "connect" && (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={connecting || !uri.trim()}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
                >
                  {connecting ? "Connecting..." : "Connect"}
                </button>
              </>
            )}
            {step === "select" && (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => setStep("confirm")}
                  disabled={selected.size === 0}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
                >
                  Import {selected.size} Filament{selected.size !== 1 ? "s" : ""}
                </button>
              </>
            )}
            {step === "confirm" && (
              <>
                <button
                  type="button"
                  onClick={() => setStep("select")}
                  className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImport}
                  className="px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-500"
                >
                  Confirm Import
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
