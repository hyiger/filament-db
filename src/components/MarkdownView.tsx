"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { safeHttpUrl } from "@/lib/safeRenderUrl";

/**
 * GH #614 — safe, dark-mode-aware Markdown renderer for the technical-reference
 * panel. Loaded via `next/dynamic({ ssr:false })` so it stays out of the detail
 * page's main bundle and only ships when a reader opens the panel.
 *
 * Security: `rehype-raw` parses the reference's inline HTML (`<sub>`/`<sup>` for
 * chemistry + units) so it renders, and `rehype-sanitize` runs AFTER it to strip
 * scripts / event handlers / `javascript:` URIs — even though the content is the
 * maintainer's own wiki, this stays safe if the future wiki edits are ever
 * tainted. No `dangerouslySetInnerHTML`. Links route through `safeHttpUrl` and
 * open externally (the OS browser, via Electron's window-open handler).
 *
 * Styling is a hand-rolled `components` map with paired `dark:` classes rather
 * than @tailwindcss/typography (one surface; the repo is Tailwind v4).
 */
const components: Components = {
  h1: ({ children }) => <h3 className="text-lg font-bold mt-5 mb-2 text-gray-900 dark:text-gray-100">{children}</h3>,
  h2: ({ children }) => <h3 className="text-lg font-semibold mt-5 mb-2 text-gray-900 dark:text-gray-100">{children}</h3>,
  h3: ({ children }) => <h3 className="text-base font-semibold mt-5 mb-2 text-gray-900 dark:text-gray-100">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold mt-4 mb-1.5 text-gray-700 dark:text-gray-200">{children}</h4>,
  h5: ({ children }) => <h5 className="text-sm font-semibold mt-3 mb-1 text-gray-600 dark:text-gray-300">{children}</h5>,
  p: ({ children }) => <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed my-2">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-2 text-sm space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-2 text-sm space-y-1">{children}</ol>,
  li: ({ children }) => <li className="text-gray-700 dark:text-gray-300">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gray-300 dark:border-gray-600 pl-3 italic text-gray-600 dark:text-gray-400 my-2">{children}</blockquote>
  ),
  hr: () => <hr className="border-gray-200 dark:border-gray-800 my-4" />,
  code: ({ children }) => (
    <code className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="bg-gray-100 dark:bg-gray-900 rounded p-3 overflow-x-auto text-xs my-3">{children}</pre>
  ),
  a: ({ href, children }) => {
    // Intentionally http(s)-only: safeHttpUrl is stricter than rehype-sanitize's
    // default href allow-list (which also permits mailto:/irc:/xmpp:). The
    // reference's links are all http(s) wiki URLs; anything else degrades to
    // plain text rather than rendering a non-http scheme.
    const safe = safeHttpUrl(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 dark:text-blue-400 hover:underline"
      >
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => (
    <th className="text-left font-semibold border-b border-gray-300 dark:border-gray-700 px-2 py-1 align-bottom text-gray-700 dark:text-gray-200">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-gray-100 dark:border-gray-800 px-2 py-1 align-top text-gray-700 dark:text-gray-300">{children}</td>
  ),
};

export default function MarkdownView({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
}
