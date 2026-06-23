import Link from "next/link";

/** A navigable Settings tile: title + description that links to a sub-page,
 *  matching the existing entity tiles (Nozzles, Printers, …). `danger` styles
 *  it red for the Danger Zone. Used on the main Settings page (#801). */
export default function SettingsTile({
  href,
  title,
  description,
  danger = false,
}: {
  href: string;
  title: string;
  description: string;
  danger?: boolean;
}) {
  const base =
    "block p-5 rounded-lg border transition-colors group";
  const tone = danger
    ? "border-red-300 dark:border-red-800 hover:border-red-400 dark:hover:border-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
    : "border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900/50";
  const titleTone = danger
    ? "text-red-600 dark:text-red-400 group-hover:text-red-700 dark:group-hover:text-red-300"
    : "text-gray-900 dark:text-gray-200 group-hover:text-black dark:group-hover:text-white";
  return (
    <Link href={href} className={`${base} ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className={`text-lg font-semibold ${titleTone}`}>{title}</h2>
          <p className="text-sm text-gray-500 mt-1">{description}</p>
        </div>
        <svg
          className={`w-5 h-5 flex-shrink-0 ${danger ? "text-red-500 group-hover:text-red-400" : "text-gray-600 group-hover:text-gray-400"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
      </div>
    </Link>
  );
}
