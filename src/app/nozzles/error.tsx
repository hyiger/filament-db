"use client";

import Link from "next/link";

export default function NozzlesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="max-w-2xl mx-auto p-8 text-center">
      <h2 className="text-xl font-bold text-red-400 mb-2">Failed to load nozzles</h2>
      <p className="text-gray-400 text-sm mb-6">
        {error.message || "An unexpected error occurred."}
      </p>
      <div className="flex gap-3 justify-center">
        <button
          onClick={reset}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Try again
        </button>
        <Link
          href="/"
          className="px-6 py-2 bg-gray-700 text-white rounded hover:bg-gray-600"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
