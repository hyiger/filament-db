"use client";

import { useState } from "react";

declare global {
  interface Window {
    electronAPI?: {
      getConfig: () => Promise<{ mongodbUri: string }>;
      saveConfig: (config: { mongodbUri: string }) => Promise<{ success: boolean }>;
      resetConfig: () => Promise<{ success: boolean }>;
      showMessage: (options: { type: string; title: string; message: string }) => Promise<void>;
    };
  }
}

export default function SetupPage() {
  const [mongoUri, setMongoUri] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
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

      // Save config via Electron IPC if available
      if (window.electronAPI) {
        await window.electronAPI.saveConfig({ mongodbUri: mongoUri });
        // Electron will redirect to home
      } else {
        // Running in browser — connection test passed but URI must be set
        // via .env.local (MONGODB_URI) since there's no persistent storage
        setSuccess(
          "Connection successful! To use the web app, add this URI as MONGODB_URI in your .env.local file and restart the server."
        );
        setTesting(false);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">Filament DB</h1>
          <p className="text-gray-500">
            Connect to your MongoDB Atlas database to get started.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
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
            />
            <p className="text-xs text-gray-500 mt-1">
              Your connection string is stored locally and never sent to any
              third party.
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

          <button
            type="submit"
            disabled={testing || !mongoUri}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {testing ? "Testing connection..." : "Connect"}
          </button>
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
