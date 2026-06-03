"use client";

import { useEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import Link from "next/link";
import "swagger-ui-react/swagger-ui.css";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function ApiDocsPage() {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);

  // GH #321 / #554: swagger-ui-react's internal components (ModelCollapse,
  // OperationContainer, …) still use the legacy UNSAFE_componentWillReceiveProps
  // lifecycle. Under the app's React StrictMode (Next's default), React logs a
  // "not recommended in strict mode" warning, and Next's dev overlay then
  // surfaces it as a blocking "Issue" that makes /api-docs look broken during
  // local/Electron QA.
  //
  // #321 removed the old global console.error monkey-patch (it intercepted ALL
  // logging app-wide while this page was open) and deliberately left the
  // warnings. Rather than re-patch console or disable StrictMode app-wide, we
  // mount SwaggerUI in its OWN React root: a root created here is not a
  // descendant of the StrictMode that Next wraps the app root in, so swagger's
  // legacy lifecycles run without the strict-mode warning while the rest of the
  // app keeps StrictMode. A fresh child node per effect run avoids React's
  // "container already passed to createRoot" warning under StrictMode's dev
  // double-invoke, and the unmount is deferred to a microtask to dodge the
  // "synchronous unmount during render" warning when the effect tears down.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mount = document.createElement("div");
    host.appendChild(mount);

    let root: Root | null = null;
    let cancelled = false;

    Promise.all([import("react-dom/client"), import("swagger-ui-react")]).then(
      ([{ createRoot }, { default: SwaggerUI }]) => {
        if (cancelled) return;
        root = createRoot(mount);
        root.render(<SwaggerUI url="/api/openapi" />);
      },
    );

    return () => {
      cancelled = true;
      const r = root;
      root = null;
      Promise.resolve().then(() => {
        r?.unmount();
        mount.remove();
      });
    };
  }, []);

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 pt-6 pb-2">
        <div className="flex gap-3">
          <Link href="/settings" className="text-blue-600 hover:underline text-sm">
            &larr; {t("apiDocs.backToSettings")}
          </Link>
        </div>
      </div>
      <div className="swagger-wrapper" ref={hostRef} />
      <style jsx global>{`
        .swagger-wrapper .swagger-ui .wrapper {
          max-width: 1400px;
          padding: 0 20px;
        }
        .swagger-wrapper .swagger-ui .info {
          margin: 20px 0;
        }
        .swagger-wrapper .swagger-ui .info .title {
          font-size: 1.75rem;
        }
        .swagger-wrapper .swagger-ui .scheme-container {
          background: transparent;
          box-shadow: none;
          padding: 15px 0;
        }
        /* Dark mode */
        @media (prefers-color-scheme: dark) {
          .swagger-wrapper .swagger-ui,
          .swagger-wrapper .swagger-ui .info .title,
          .swagger-wrapper .swagger-ui .info p,
          .swagger-wrapper .swagger-ui .info li,
          .swagger-wrapper .swagger-ui .info a,
          .swagger-wrapper .swagger-ui .opblock-tag,
          .swagger-wrapper .swagger-ui .opblock-tag small,
          .swagger-wrapper .swagger-ui table thead tr th,
          .swagger-wrapper .swagger-ui table thead tr td,
          .swagger-wrapper .swagger-ui .parameter__name,
          .swagger-wrapper .swagger-ui .parameter__type,
          .swagger-wrapper .swagger-ui .parameter__in,
          .swagger-wrapper .swagger-ui .response-col_status,
          .swagger-wrapper .swagger-ui .response-col_description,
          .swagger-wrapper .swagger-ui .response-col_links,
          .swagger-wrapper .swagger-ui .tab li,
          .swagger-wrapper .swagger-ui .opblock-description-wrapper p,
          .swagger-wrapper .swagger-ui .opblock-external-docs-wrapper p,
          .swagger-wrapper .swagger-ui .opblock-section-header h4,
          .swagger-wrapper .swagger-ui .opblock-section-header label,
          .swagger-wrapper .swagger-ui .btn,
          .swagger-wrapper .swagger-ui select,
          .swagger-wrapper .swagger-ui label,
          .swagger-wrapper .swagger-ui .model-title,
          .swagger-wrapper .swagger-ui .model,
          .swagger-wrapper .swagger-ui .model span,
          .swagger-wrapper .swagger-ui .model .property,
          .swagger-wrapper .swagger-ui section.models h4,
          .swagger-wrapper .swagger-ui .renderedMarkdown p {
            color: #e0e0e0;
          }
          .swagger-wrapper .swagger-ui .opblock-tag {
            border-bottom-color: #444;
          }
          .swagger-wrapper .swagger-ui .opblock {
            border-color: #444;
          }
          .swagger-wrapper .swagger-ui .opblock .opblock-summary {
            border-bottom-color: #444;
          }
          .swagger-wrapper .swagger-ui .opblock-section-header {
            background: #1a1a2e;
          }
          .swagger-wrapper .swagger-ui section.models {
            border-color: #444;
          }
          .swagger-wrapper .swagger-ui section.models .model-container {
            background: #1a1a2e;
          }
          .swagger-wrapper .swagger-ui .model-box {
            background: #1a1a2e;
          }
          .swagger-wrapper .swagger-ui .highlight-code,
          .swagger-wrapper .swagger-ui .microlight {
            background: #0d1117 !important;
            color: #c9d1d9 !important;
          }
          .swagger-wrapper .swagger-ui textarea {
            background: #1a1a2e;
            color: #e0e0e0;
          }
          .swagger-wrapper .swagger-ui input[type=text] {
            background: #1a1a2e;
            color: #e0e0e0;
          }
          .swagger-wrapper .swagger-ui .scheme-container {
            background: transparent;
          }
        }
      `}</style>
    </div>
  );
}
