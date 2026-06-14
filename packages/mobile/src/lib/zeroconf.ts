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

/**
 * Build a Filament DB server entry from a resolved zeroconf service. Prefers an
 * IPv4 address over the `.local` hostname — phones reach a raw LAN IP reliably,
 * whereas `.local` resolution over HTTP is flaky on some networks. Returns null
 * when the service carries no usable address or port. Pure + unit-testable.
 */
export function discoveredServerFromService(
  svc: ZeroconfService | null | undefined,
): DiscoveredServer | null {
  if (!svc || !svc.port) return null;
  const ipv4 = (svc.addresses ?? []).find((a) => IPV4_RE.test(a));
  const host = ipv4 ?? (svc.host ? svc.host.replace(/\.$/, '') : null);
  if (!host) return null;
  const url = `http://${host}:${svc.port}`;
  return { id: url, name: svc.name?.trim() || host, url };
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
export function useServerDiscovery(): ServerDiscovery {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [supported, setSupported] = useState(true);
  const zcRef = useRef<ZeroconfInstance | null>(null);

  const stop = useCallback(() => {
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
      const server = discoveredServerFromService(svc);
      if (!server) return;
      setServers((prev) => (prev.some((s) => s.id === server.id) ? prev : [...prev, server]));
    });
    zc.on('error', (err) => {
      console.warn('zeroconf error', err);
    });
    try {
      zc.scan('filamentdb', 'tcp', 'local.');
    } catch (err) {
      console.warn('zeroconf scan failed', err);
      setSupported(false);
      stop();
    }
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return { servers, scanning, supported, scan, stop };
}
