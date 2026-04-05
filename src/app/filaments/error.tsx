"use client";

import Link from "next/link";

export default function FilamentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="max-w-2xl mx-auto p-8 text-center">
      <h2 className="text-xl font-bold text-red-600 dark:text-red-400 mb-2">Failed to load filaments</h2>
      <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">
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
          className="px-6 py-2 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded hover:bg-gray-300 dark:hover:bg-gray-600"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
