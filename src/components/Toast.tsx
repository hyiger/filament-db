"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface Toast {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

interface ToastOpts {
  /** Override the auto-dismiss delay in ms. Defaults to a length-scaled value;
   * pass 0 to keep the toast until manually dismissed. */
  duration?: number;
}

interface ToastContextValue {
  toast: (message: string, type?: Toast["type"], opts?: ToastOpts) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) return { toast: () => {} };
  return ctx;
}

let nextId = 0;

/**
 * Compute a readable auto-dismiss duration based on message length.
 *
 * Rationale: a 4-second fixed duration was too short for longer success
 * messages (import summaries, multi-action confirmations) but overkill for
 * short acknowledgments. Rough estimate: ~60 words per minute reading speed
 * ≈ 200 ms per character as a lower bound, clamped to a reasonable range.
 *
 * Errors are held longer because the user typically needs to read and act.
 */
export function computeToastDuration(
  message: string,
  type: Toast["type"] = "success",
): number {
  const minMs = type === "error" ? 6_000 : 4_000;
  const maxMs = type === "error" ? 15_000 : 10_000;
  const perCharMs = 60;
  return Math.max(minMs, Math.min(maxMs, message.length * perCharMs));
}

export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback(
    (message: string, type: Toast["type"] = "success", opts: ToastOpts = {}) => {
      const id = ++nextId;
      setToasts((prev) => {
        const next = [...prev, { id, message, type }];
        // Cap visible toasts at 5 — drop oldest when exceeded
        return next.length > 5 ? next.slice(-5) : next;
      });
      const duration =
        opts.duration !== undefined ? opts.duration : computeToastDuration(message, type);
      if (duration > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
      }
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="alert"
            className={`px-4 py-3 rounded-lg shadow-lg text-sm text-white flex items-center gap-2 animate-slide-in ${
              t.type === "success"
                ? "bg-green-600"
                : t.type === "error"
                  ? "bg-red-600"
                  : "bg-blue-600"
            }`}
          >
            <span className="flex-1">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="text-white/70 hover:text-white text-lg leading-none"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
