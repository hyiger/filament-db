import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * mDNS / Bonjour discovery of Filament DB desktop instances on the LAN.
 *
 * The desktop app advertises `_filamentdb._tcp` when "Share on local network"
 * is enabled; this lets the phone find it and fill in the server address
 * without the user typing an IP. Uses react-native-zeroconf (a native module,
 * present in dev/standalone builds — gracefully no-ops where it isn't, e.g.
 * web / Expo Go, via `supported: false`).
 */

export interface DiscoveredServer {
  /** Stable id (the URL) for dedupe + list keys. */
  id: string;
  /** Advertised instance name, e.g. "Filament DB". */
  name: string;
  /** Full base URL to use as the server address, e.g. http://192.168.1.50:3456 */
  url: string;
}

/** Subset of react-native-zeroconf's resolved-service object that we read. */
export interface ZeroconfService {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** RFC1918 private ranges — the addresses a phone on the same Wi-Fi can route
 *  to. Sorted ahead of anything else so the likely-LAN candidate leads. */
function isPrivateIpv4(ip: string): boolean {
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  const m = /^172\.(\d{1,3})\./.exec(ip);
  return m ? Number(m[1]) >= 16 && Number(m[1]) <= 31 : false;
}

/**
 * Build the candidate server entries from a resolved zeroconf service.
 *
 * A desktop with several non-loopback interfaces (Wi-Fi + Docker/VM/VPN) is
 * advertised with multiple IPv4 addresses, and only some are reachable from the
 * phone. Rather than guess one (Codex #723), return EVERY usable IPv4 as its own
 * entry — RFC1918 private addresses first — so the user can pick the one that
 * connects. Falls back to the `.local` hostname only when no IPv4 is offered.
 * Returns [] when the service has no usable address/port. Pure + unit-testable.
 */
export function discoveredServersFromService(
  svc: ZeroconfService | null | undefined,
): DiscoveredServer[] {
  if (!svc || !svc.port) return [];
  const name = svc.name?.trim() ?? '';
  const ipv4s = (svc.addresses ?? [])
    .filter((a) => IPV4_RE.test(a) && !a.startsWith('169.254.')) // skip link-local APIPA
    .sort((a, b) => (isPrivateIpv4(a) ? 0 : 1) - (isPrivateIpv4(b) ? 0 : 1));
  const hosts = ipv4s.length > 0 ? ipv4s : svc.host ? [svc.host.replace(/\.$/, '')] : [];
  return hosts.map((host) => {
    const url = `http://${host}:${svc.port}`;
    return { id: url, name: name || host, url };
  });
}

interface ZeroconfInstance {
  on(event: 'resolved', listener: (service: ZeroconfService) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  scan(type: string, protocol: string, domain: string): void;
  stop(): void;
  removeDeviceListeners(): void;
}

/** Lazily construct a Zeroconf instance. `require` (not a top-level import) so a
 *  build without the native module — web / Expo Go — doesn't crash on load. */
function loadZeroconf(): ZeroconfInstance | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-zeroconf');
    const Ctor = (mod?.default ?? mod) as { new (): ZeroconfInstance };
    return new Ctor();
  } catch {
    return null;
  }
}

export interface ServerDiscovery {
  servers: DiscoveredServer[];
  scanning: boolean;
  /** False when the native module isn't available (web / Expo Go). */
  supported: boolean;
  scan: () => void;
  stop: () => void;
}

/**
 * Hook: scan the LAN for Filament DB desktop instances. Call `scan()` to start
 * (e.g. on the settings screen) and the returned `servers` list fills in as
 * instances resolve. Scanning stops on unmount.
 */
/** Bound the scanning window. Android's default NSD backend can fail SILENTLY
 *  (no 'resolved' and no 'error' — react-native-zeroconf 0.14 documents this),
 *  so neither the resolved handler nor the error handler would ever clear
 *  `scanning`, stranding the UI on "Scanning…". A hard timeout guarantees the
 *  Scan button re-enables; servers found during the window stay listed and the
 *  user can Rescan. (Codex #723.) */
const SCAN_TIMEOUT_MS = 15_000;

export function useServerDiscovery(): ServerDiscovery {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [supported, setSupported] = useState(true);
  const zcRef = useRef<ZeroconfInstance | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const zc = zcRef.current;
    zcRef.current = null;
    if (zc) {
      try {
        zc.stop();
      } catch {
        // ignore — best effort
      }
      try {
        zc.removeDeviceListeners();
      } catch {
        // ignore
      }
    }
    setScanning(false);
  }, []);

  const scan = useCallback(() => {
    stop();
    const zc = loadZeroconf();
    if (!zc) {
      setSupported(false);
      return;
    }
    zcRef.current = zc;
    setServers([]);
    setScanning(true);
    zc.on('resolved', (svc) => {
      const found = discoveredServersFromService(svc);
      if (found.length === 0) return;
      setServers((prev) => {
        const next = [...prev];
        for (const s of found) {
          if (!next.some((p) => p.id === s.id)) next.push(s);
        }
        return next;
      });
    });
    zc.on('error', (err) => {
      console.warn('zeroconf error', err);
      // Tear down so `scanning` clears and the Scan button re-enables — an async
      // error (denied iOS Local Network permission, Android NSD failure) would
      // otherwise strand the UI in a permanent "Scanning…" state (Codex #723).
      stop();
    });
    try {
      zc.scan('filamentdb', 'tcp', 'local.');
      // Hard stop after the window so a silent native failure can't hang the UI.
      timeoutRef.current = setTimeout(stop, SCAN_TIMEOUT_MS);
    } catch (err) {
      console.warn('zeroconf scan failed', err);
      setSupported(false);
      stop();
    }
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return { servers, scanning, supported, scan, stop };
}
