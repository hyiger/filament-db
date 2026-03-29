import Link from "next/link";

export default function SettingsPage() {
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

      <div className="mt-8 pt-6 border-t border-gray-800">
        <p className="text-xs text-gray-600">
          Filament DB v{process.env.APP_VERSION}
        </p>
      </div>
    </main>
  );
}
