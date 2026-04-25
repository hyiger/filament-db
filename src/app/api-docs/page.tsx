"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import "swagger-ui-react/swagger-ui.css";
import { useTranslation } from "@/i18n/TranslationProvider";

const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

export default function ApiDocsPage() {
  const { t } = useTranslation();

  // Suppress known React deprecation warnings from swagger-ui-react internals
  useEffect(() => {
    const origWarn = console.error;
    console.error = (...args: unknown[]) => {
      if (
        typeof args[0] === "string" &&
        (args[0].includes("UNSAFE_componentWillReceiveProps") ||
         args[0].includes("UNSAFE_componentWillMount"))
      ) return;
      origWarn.apply(console, args);
    };
    return () => { console.error = origWarn; };
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
      <div className="swagger-wrapper">
        <SwaggerUI url="/api/openapi" />
      </div>
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
