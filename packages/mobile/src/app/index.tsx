import { Link, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError, createApi } from '@/lib/api';
import { NFC_ENABLED } from '@/lib/features';
import { readOpenPrintTag } from '@/lib/nfc';
import { setPendingScan } from '@/lib/pendingScan';
import { useServerConfig } from '@/lib/serverConfig';
import { useColors } from '@/lib/theme';

export default function ScanScreen() {
  const { baseUrl, apiKey, loading } = useServerConfig();
  const router = useRouter();
  const c = useColors();
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
        <Text style={[styles.title, { color: c.text }]}>Not connected</Text>
        <Text style={[styles.muted, { color: c.muted }]}>
          Set your Filament DB server address to start scanning spools.
        </Text>
        <Link href="/settings" asChild>
          <Pressable style={StyleSheet.flatten([styles.button, { backgroundColor: c.tint }])}>
            <Text style={[styles.buttonText, { color: c.onTint }]}>Open server settings</Text>
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
      const decoded = res.decoded;
      const goCreate = () => {
        // The create screen consumes the handed-off scan and POSTs it back as
        // tagData; the server does the field mapping (Phase 2).
        setPendingScan(decoded);
        router.push('/create-from-tag');
      };

      // Only an instanceId match is confident enough to open directly — the
      // tag is one Filament DB wrote for this filament (its spool_uid is the
      // filament's instanceId). A weaker heuristic match (name / vendor+type)
      // can be a different color of a filament you already own, so never treat
      // it as "this exact tag is in the DB": offer to open it OR create the scan.
      if (res.match?._id && res.matchedBy === 'instanceId') {
        router.push({ pathname: '/filament/[id]', params: { id: res.match._id } });
        return;
      }
      const name = `${res.decoded.brandName ?? ''} ${res.decoded.materialName ?? ''}`.trim();
      if (res.match?._id) {
        const matchId = res.match._id;
        const matchName = res.match.name ?? 'the match';
        Alert.alert(
          name || 'Tag decoded',
          `Closest match: ${matchName}. This may be a different color or variant — open it, or create a new filament from this tag?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Open match',
              onPress: () => router.push({ pathname: '/filament/[id]', params: { id: matchId } }),
            },
            { text: 'Create new', onPress: goCreate },
          ],
        );
        return;
      }
      const detail = res.candidates.length
        ? `${res.candidates.length} possible match(es) exist, but none is an exact match.`
        : "This tag isn't in your database yet.";
      Alert.alert(name || 'Tag decoded', `${detail}\n\nCreate a new filament from this tag?`, [
        { text: 'Not now', style: 'cancel' },
        { text: 'Create filament', onPress: goCreate },
      ]);
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
          style={[styles.bigButton, { backgroundColor: c.tint }, busy && styles.disabled]}
          onPress={() => router.push('/scan-qr')}
          disabled={busy}
        >
          <Text style={[styles.bigButtonText, { color: c.onTint }]}>Scan QR code</Text>
          <Text style={styles.bigButtonHint}>Filament DB label</Text>
        </Pressable>
        {NFC_ENABLED && (
          <Pressable
            style={[styles.bigButton, { backgroundColor: c.tint }, busy && styles.disabled]}
            onPress={scanNfc}
            disabled={busy}
          >
            <Text style={[styles.bigButtonText, { color: c.onTint }]}>
              {busy ? 'Scanning…' : 'Scan NFC tag'}
            </Text>
            <Text style={styles.bigButtonHint}>OpenPrintTag</Text>
          </Pressable>
        )}
      </View>
      <Link href="/settings" style={[styles.footerLink, { color: c.tint }]}>
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
  muted: { fontSize: 15, textAlign: 'center' },
  button: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  bigButton: {
    paddingVertical: 28,
    borderRadius: 16,
    alignItems: 'center',
    gap: 4,
  },
  bigButtonText: { fontSize: 20, fontWeight: '600' },
  bigButtonHint: { color: '#dceaff', fontSize: 13 },
  disabled: { opacity: 0.5 },
  footerLink: { textAlign: 'center', paddingVertical: 8 },
});
