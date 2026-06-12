import { Link, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError, createApi } from '@/lib/api';
import { readOpenPrintTag } from '@/lib/nfc';
import { useServerConfig } from '@/lib/serverConfig';

export default function ScanScreen() {
  const { baseUrl, apiKey, loading } = useServerConfig();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  }

  if (!baseUrl) {
    return (
      <Centered>
        <Text style={styles.title}>Not connected</Text>
        <Text style={styles.muted}>
          Set your Filament DB server address to start scanning spools.
        </Text>
        <Link href="/settings" asChild>
          <Pressable style={styles.button}>
            <Text style={styles.buttonText}>Open server settings</Text>
          </Pressable>
        </Link>
      </Centered>
    );
  }

  const api = createApi({ baseUrl, apiKey });

  async function scanNfc() {
    setBusy(true);
    try {
      const scan = await readOpenPrintTag();
      const res = await api.decodeNfc(scan);
      if (res.match?._id) {
        router.push({ pathname: '/filament/[id]', params: { id: res.match._id } });
        return;
      }
      const name = `${res.decoded.brandName ?? ''} ${res.decoded.materialName ?? ''}`.trim();
      Alert.alert(
        'Tag decoded',
        (name || 'Unknown filament') +
          (res.candidates.length
            ? `\n\n${res.candidates.length} possible match(es) in your database.`
            : '\n\nNot in your database yet.'),
      );
    } catch (e) {
      Alert.alert('Scan failed', e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.actions}>
        <Pressable
          style={[styles.bigButton, busy && styles.disabled]}
          onPress={() => router.push('/scan-qr')}
          disabled={busy}
        >
          <Text style={styles.bigButtonText}>Scan QR code</Text>
          <Text style={styles.bigButtonHint}>Filament DB label</Text>
        </Pressable>
        <Pressable
          style={[styles.bigButton, busy && styles.disabled]}
          onPress={scanNfc}
          disabled={busy}
        >
          <Text style={styles.bigButtonText}>{busy ? 'Scanning…' : 'Scan NFC tag'}</Text>
          <Text style={styles.bigButtonHint}>OpenPrintTag</Text>
        </Pressable>
      </View>
      <Link href="/settings" style={styles.footerLink}>
        Server: {baseUrl}
      </Link>
    </SafeAreaView>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, justifyContent: 'space-between' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  actions: { flex: 1, justifyContent: 'center', gap: 16 },
  title: { fontSize: 22, fontWeight: '600' },
  muted: { fontSize: 15, opacity: 0.7, textAlign: 'center' },
  button: { backgroundColor: '#208AEF', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  bigButton: {
    backgroundColor: '#208AEF',
    paddingVertical: 28,
    borderRadius: 16,
    alignItems: 'center',
    gap: 4,
  },
  bigButtonText: { color: '#fff', fontSize: 20, fontWeight: '600' },
  bigButtonHint: { color: '#dceaff', fontSize: 13 },
  disabled: { opacity: 0.5 },
  footerLink: { textAlign: 'center', color: '#208AEF', paddingVertical: 8 },
});
