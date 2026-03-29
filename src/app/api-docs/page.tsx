"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import "swagger-ui-react/swagger-ui.css";

const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

export default function ApiDocsPage() {
  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; Back to filaments
        </Link>
      </div>
      <div className="swagger-wrapper">
        <SwaggerUI url="/openapi.json" />
      </div>
      <style jsx global>{`
        .swagger-wrapper .swagger-ui {
          font-family: inherit;
        }
        .swagger-wrapper .swagger-ui .info .title {
          font-size: 1.75rem;
        }
        /* Dark mode overrides */
        @media (prefers-color-scheme: dark) {
          .swagger-wrapper .swagger-ui {
            filter: invert(88%) hue-rotate(180deg);
          }
          .swagger-wrapper .swagger-ui .model-box,
          .swagger-wrapper .swagger-ui textarea,
          .swagger-wrapper .swagger-ui input[type=text],
          .swagger-wrapper .swagger-ui input[type=file] {
            filter: invert(100%) hue-rotate(180deg);
          }
        }
      `}</style>
    </main>
  );
}
