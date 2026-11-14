/**
 * Next.js instrumentation hook: `register` runs once when the server process
 * starts, before it serves a request.
 *
 * Its one job is to start the secure gateway (HTTPS + API key, see
 * src/lib/secureGateway.ts) when `FILAMENTDB_HTTPS_PORT` asks for one. Running
 * it here, inside the server process, is what gives the desktop app's embedded
 * server and a container the same gateway with no second process to manage.
 *
 * The import is dynamic and Node-only: the gateway needs `node:https`, and
 * Next also evaluates this file for runtimes that do not have it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSecureGateway } = await import("@/lib/gatewayRuntime");
  await startSecureGateway();
}
