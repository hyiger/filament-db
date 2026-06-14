import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError, createApi } from '@/lib/api';
import { useServerConfig } from '@/lib/serverConfig';
import { useColors } from '@/lib/theme';

export default function ScanQrScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const { baseUrl, apiKey } = useServerConfig();
  const router = useRouter();
  const c = useColors();
  const handled = useRef(false);
  const [error, setError] = useState<string | null>(null);

  if (!permission) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.text, { color: c.text }]}>Checking camera permission…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.text, { color: c.text }]}>
          Camera access is needed to scan QR codes.
        </Text>
        <Pressable style={[styles.button, { backgroundColor: c.tint }]} onPress={requestPermission}>
          <Text style={[styles.buttonText, { color: c.onTint }]}>Grant permission</Text>
        </Pressable>
      </View>
    );
  }

  async function onScanned(data: string) {
    if (handled.current || !baseUrl) return;
    handled.current = true;
    setError(null);
    try {
      // Filament DB labels encode either a deep-link URL (/filaments/{id}, with an
      // optional ?spool=<id> for spool-specific labels — GH #595) or a bare
      // instanceId. Parse the URL form first; otherwise resolve via match.
      const api = createApi({ baseUrl, apiKey });
      const parsed = parseFilamentDeepLink(data);
      if (parsed) {
        // Spool deep-link: resolve the spool server-side (the single-spool
        // endpoint) so the filament id comes authoritatively from the spool,
        // falling back to the id embedded in the URL when the server can't
        // resolve it (an older server without the endpoint, or a transient
        // error — the URL still carries a usable filament id).
        if (parsed.spool) {
          try {
            const { filament } = await api.getSpool(parsed.spool);
            router.replace({
              pathname: '/filament/[id]',
              params: { id: filament._id, spool: parsed.spool },
            });
            return;
          } catch {
            // fall through to the URL-embedded filament id below
          }
        }
        router.replace({
          pathname: '/filament/[id]',
          params: parsed.spool ? { id: parsed.id, spool: parsed.spool } : { id: parsed.id },
        });
        return;
      }
      const res = await api.matchByInstanceId(data.trim());
      if (res.match?._id) {
        router.replace({ pathname: '/filament/[id]', params: { id: res.match._id } });
      } else {
        setError('No filament matched that code.');
        handled.current = false;
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      handled.current = false;
    }
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => onScanned(data)}
      />
      <View style={styles.overlay} pointerEvents="none">
        <Text style={styles.overlayText}>{error ?? 'Point the camera at a spool QR code'}</Text>
      </View>
    </View>
  );
}

/**
 * Parse a scanned Filament DB deep-link URL into its filament id and optional
 * spool id. Mirrors buildFilamentDeepLink (src/lib/labelDeepLink.ts):
 * `/filaments/{id}` or `/filaments/{id}?spool=<spoolId>`. Returns null for
 * non-URL payloads (a bare instanceId), so those fall through to match resolve.
 */
function parseFilamentDeepLink(s: string): { id: string; spool: string | null } | null {
  const m = /\/filaments\/([^/?#]+)/.exec(s);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const q = /[?&]spool=([^&#]+)/.exec(s);
  const spool = q ? decodeURIComponent(q[1]) : null;
  return { id, spool: spool && spool.trim() ? spool : null };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  text: { fontSize: 16, textAlign: 'center' },
  button: { backgroundColor: '#208AEF', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  overlay: { position: 'absolute', bottom: 48, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 24 },
  overlayText: {
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
    backgroundColor: '#000000aa',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    overflow: 'hidden',
  },
});
