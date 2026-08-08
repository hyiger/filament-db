import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";
import { waitForServer } from "../electron/wait-for-server";

/**
 * GH #1077 — the Electron startup probe must be BOUNDED in every failure
 * mode. The pre-fix inline version in main.ts read its deadline only
 * inside `req.on("error")` and set no socket timeout, so a listener that
 * accepted the TCP connection and never wrote a response left the
 * promise permanently unsettled — the app hung at startup with no window
 * and no error. These tests drive the extracted helper against real
 * sockets:
 *   - a normal HTTP server → resolves
 *   - accept-and-never-respond → the overall deadline rejects (the exact
 *     pre-fix hang, reproduced in the issue with a net.createServer)
 *   - accept-silent then healthy → the per-attempt socket timeout turns
 *     the silent attempt into a retry that succeeds
 *   - connection refused → retry loop preserved; deadline still bounds it
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

/** Listen on an OS-assigned port (all interfaces, so `localhost` resolves
 * to it whether the OS prefers ::1 or 127.0.0.1) and return the port. */
function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("waitForServer", () => {
  it("resolves once the server answers an HTTP request", async () => {
    const server = http.createServer((_req, res) => {
      res.end("ok");
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));

    await expect(waitForServer(port, 5000, 2000)).resolves.toBeUndefined();
  });

  it("rejects at the overall deadline when the socket connects but the server never responds", async () => {
    // The GH #1077 reproduction: a raw TCP listener that accepts and
    // stays silent. attemptTimeoutMs is set LARGER than the overall
    // deadline so only the deadline timer can settle the promise —
    // proving it fires regardless of socket state. Pre-fix this promise
    // never settled and the test would time out.
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // never respond
    });
    const port = await listen(server);
    cleanups.push(async () => {
      for (const s of sockets) s.destroy();
      await closeServer(server);
    });

    await expect(waitForServer(port, 1000, 60_000)).rejects.toThrow(
      "Server startup timed out",
    );
  });

  it("turns an accepted-but-silent attempt into a retry via the per-attempt socket timeout", async () => {
    // First connection: accepted and left silent — the per-attempt
    // timeout must destroy it and schedule a retry. Later connections:
    // answered. The probe must resolve well before the overall deadline.
    const sockets = new Set<net.Socket>();
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      if (connections === 1) {
        return; // silent — must NOT hang the probe
      }
      socket.end(
        "HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
      );
    });
    const port = await listen(server);
    cleanups.push(async () => {
      for (const s of sockets) s.destroy();
      await closeServer(server);
    });

    await expect(waitForServer(port, 15_000, 200)).resolves.toBeUndefined();
    expect(connections).toBeGreaterThanOrEqual(2);
  });

  it("keeps retrying connection-refused until the server appears", async () => {
    // Reserve a port, free it, start probing it, then bring a real
    // server up on it — the pre-existing retry loop must still connect.
    const placeholder = net.createServer();
    const port = await listen(placeholder);
    await closeServer(placeholder);

    const probe = waitForServer(port, 15_000, 2000);

    const server = http.createServer((_req, res) => {
      res.end("ok");
    });
    cleanups.push(() => closeServer(server));
    await new Promise((resolve) => setTimeout(resolve, 700));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => resolve());
    });

    await expect(probe).resolves.toBeUndefined();
  });

  it("rejects at the deadline when nothing ever listens (connection refused)", async () => {
    const placeholder = net.createServer();
    const port = await listen(placeholder);
    await closeServer(placeholder);

    await expect(waitForServer(port, 900, 2000)).rejects.toThrow(
      "Server startup timed out",
    );
  });
});
