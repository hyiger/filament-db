"use client";

import { useState } from "react";

type ConnectionMode = "atlas" | "offline" | "hybrid" | "";

export default function SetupPage() {
  const [mode, setMode] = useState<ConnectionMode>("");
  const [mongoUri, setMongoUri] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const isElectron = typeof window !== "undefined" && !!window.electronAPI;

  const handleAtlasConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setTesting(true);
    setError("");
    setSuccess("");

    try {
      // Test the connection via API
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mongodbUri: mongoUri }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Connection failed");
        setTesting(false);
        return;
      }

      if (window.electronAPI) {
        await window.electronAPI.saveConfig({
          connectionMode: mode === "hybrid" ? "hybrid" : "atlas",
          atlasUri: mongoUri,
        });
        // Electron will redirect to home
      } else {
        setSuccess(
          "Connection successful! To use the web app, add this URI as MONGODB_URI in your .env.local file and restart the server."
        );
        setTesting(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setTesting(false);
    }
  };

  const handleOfflineSetup = async () => {
    if (!window.electronAPI) {
      setError("Offline mode is only available in the desktop app.");
      return;
    }

    setTesting(true);
    setError("");

    try {
      await window.electronAPI.saveConfig({
        connectionMode: "offline",
      });
      // Electron will redirect to home
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setTesting(false);
    }
  };

  // Mode not yet selected — show options
  if (!mode) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-lg w-full">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">Filament DB</h1>
            <p className="text-gray-500">
              Choose how you want to store your filament data.
            </p>
          </div>

          <div className="space-y-3">
            {/* Atlas (Cloud) */}
            <button
              onClick={() => setMode("atlas")}
              className="w-full text-left p-4 border border-gray-600 rounded-lg hover:border-blue-500 hover:bg-blue-500/5 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="text-2xl mt-0.5">&#9729;</div>
                <div>
                  <div className="font-semibold text-white">MongoDB Atlas (Cloud)</div>
                  <p className="text-sm text-gray-400 mt-1">
                    Connect to a MongoDB Atlas cloud database. Your data is stored remotely and accessible from anywhere.
                    Requires an internet connection.
                  </p>
                </div>
              </div>
            </button>

            {/* Hybrid */}
            {isElectron && (
              <button
                onClick={() => setMode("hybrid")}
                className="w-full text-left p-4 border border-gray-600 rounded-lg hover:border-purple-500 hover:bg-purple-500/5 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="text-2xl mt-0.5">&#8644;</div>
                  <div>
                    <div className="font-semibold text-white">Hybrid (Local + Cloud Sync)</div>
                    <p className="text-sm text-gray-400 mt-1">
                      Store data locally with automatic sync to MongoDB Atlas when connected. Works offline and syncs
                      when internet is available. <span className="text-gray-500">Recommended.</span>
                    </p>
                  </div>
                </div>
              </button>
            )}

            {/* Offline Only */}
            {isElectron && (
              <button
                onClick={() => setMode("offline")}
                className="w-full text-left p-4 border border-gray-600 rounded-lg hover:border-green-500 hover:bg-green-500/5 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="text-2xl mt-0.5">&#128190;</div>
                  <div>
                    <div className="font-semibold text-white">Local Only (Offline)</div>
                    <p className="text-sm text-gray-400 mt-1">
                      All data is stored locally on this computer. No cloud account or internet connection needed.
                      You can switch to hybrid mode later.
                    </p>
                  </div>
                </div>
              </button>
            )}
          </div>

          {!isElectron && (
            <p className="text-xs text-gray-500 mt-6 text-center">
              Offline and hybrid modes are available in the{" "}
              <a href="https://github.com/hyiger/filament-db/releases" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">
                desktop app
              </a>.
            </p>
          )}
        </div>
      </main>
    );
  }

  // Offline mode — confirm and go
  if (mode === "offline") {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">Filament DB</h1>
            <p className="text-gray-500">Local Offline Mode</p>
          </div>

          <div className="p-4 bg-gray-800 border border-gray-700 rounded-lg mb-6">
            <p className="text-sm text-gray-300 mb-3">
              Your filament data will be stored in a local database on this computer. An internet connection may be needed on first launch to download the database engine; after that, no internet is required.
            </p>
            <p className="text-xs text-gray-500">
              You can switch to hybrid mode later by resetting the configuration (see Troubleshooting).
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300 mb-4">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setMode("")}
              className="flex-1 px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
            >
              Back
            </button>
            <button
              onClick={handleOfflineSetup}
              disabled={testing}
              className="flex-1 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-500 disabled:opacity-50 text-sm"
            >
              {testing ? "Setting up..." : "Start Offline"}
            </button>
          </div>
        </div>
      </main>
    );
  }

  // Atlas or Hybrid mode — need connection string
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">Filament DB</h1>
          <p className="text-gray-500">
            {mode === "hybrid"
              ? "Enter your Atlas URI for cloud sync. Data will be stored locally and synced when connected."
              : "Connect to your MongoDB Atlas database to get started."}
          </p>
        </div>

        {mode === "hybrid" && (
          <div className="p-3 bg-purple-900/20 border border-purple-800 rounded-lg mb-4 text-xs text-purple-300">
            <strong>Hybrid mode:</strong> Your data is stored locally and automatically synced to Atlas.
            If Atlas is unreachable, the app works offline and syncs when the connection is restored.
          </div>
        )}

        <form onSubmit={handleAtlasConnect} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              MongoDB Connection String
            </label>
            <input
              type="password"
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-transparent"
              value={mongoUri}
              onChange={(e) => setMongoUri(e.target.value)}
              placeholder="mongodb+srv://user:pass@cluster.mongodb.net/filament-db"
              required
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              Your connection string is stored locally and never sent to any third party.
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-800 rounded text-sm text-green-700 dark:text-green-300">
              {success}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setMode(""); setError(""); setSuccess(""); }}
              className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={testing || !mongoUri}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
            >
              {testing ? "Testing connection..." : "Connect"}
            </button>
          </div>
        </form>

        <div className="mt-8 text-xs text-gray-500 space-y-2">
          <p>
            <strong>Need a MongoDB Atlas account?</strong> Sign up for free at{" "}
            <a
              href="https://www.mongodb.com/cloud/atlas/register"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              mongodb.com/atlas
            </a>
          </p>
          <p>
            Your connection string looks like:{" "}
            <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
              mongodb+srv://user:password@cluster.mongodb.net/filament-db
            </code>
          </p>
        </div>
      </div>
    </main>
  );
}
