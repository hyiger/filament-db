import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { checkConnection } from '@/lib/connectionCheck';
import type { ConnectionProblem, DevicePlatform } from '@/lib/connectionDiagnosis';
import { ADDRESS_EXAMPLE, LEGACY_ADDRESS_EXAMPLE, parseServerAddress } from '@/lib/serverAddress';
import { useServerConfig } from '@/lib/serverConfig';
import { cleartextKeyWarning, keyFieldState, planSave, type SavePlan } from '@/lib/serverKeyPolicy';
import { useColors } from '@/lib/theme';
import { useServerDiscovery } from '@/lib/zeroconf';

type OkPlan = Extract<SavePlan, { ok: true }>;

const PLATFORM: DevicePlatform =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other';

export default function SettingsScreen() {
  const { baseUrl, apiKey, save } = useServerConfig();
  const [url, setUrl] = useState(baseUrl ?? '');
  // null until the user edits the key field. Until then the field shows the
  // SAVED key only while the address still names the server it was saved for
  // (serverKeyPolicy.keyFieldState) — never for a discovered or retyped one.
  const [typedKey, setTypedKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'saving'>('idle');
  // The last check that failed, and the exact plan it was run for, so "Save
  // anyway" can only save what was checked. Editing either field clears both.
  const [failed, setFailed] = useState<{ problem: ConnectionProblem; plan: OkPlan } | null>(null);
  const { servers, scanning, supported, scan } = useServerDiscovery();
  const router = useRouter();
  const c = useColors();

  const stored = { baseUrl, apiKey };
  const keyField = keyFieldState({ stored, address: url, typedKey });
  const busy = phase !== 'idle';

  function editUrl(next: string) {
    setUrl(next);
    setFailed(null);
  }

  function editKey(next: string) {
    setTypedKey(next);
    setFailed(null);
  }

  async function persist(plan: OkPlan) {
    setPhase('saving');
    try {
      await save({ baseUrl: plan.baseUrl, apiKey: plan.apiKey });
      router.back();
    } catch (e) {
      Alert.alert('Could not save', (e as Error).message);
    } finally {
      setPhase('idle');
    }
  }

  async function checkAndSave(plan: OkPlan) {
    if (plan.baseUrl === null) {
      await persist(plan);
      return;
    }
    setFailed(null);
    setPhase('checking');
    const result = await checkConnection({ baseUrl: plan.baseUrl, apiKey: plan.apiKey }, PLATFORM);
    if (result.ok) {
      await persist(plan);
      return;
    }
    setFailed({ problem: result.problem, plan });
    setPhase('idle');
  }

  function onSave() {
    const plan = planSave({
      stored,
      address: url,
      key: keyField.value,
      discoveredUrls: servers.map((s) => s.url),
    });
    if (!plan.ok) {
      Alert.alert('Invalid server address', plan.error);
      return;
    }
    if (plan.cleartextKey && plan.baseUrl) {
      // Asked BEFORE the connection check: the check is what first sends the key.
      const warning = cleartextKeyWarning(plan.cleartextKey, plan.baseUrl);
      Alert.alert(warning.title, warning.message, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: warning.confirmLabel,
          style: 'destructive',
          onPress: () => void checkAndSave(plan),
        },
      ]);
      return;
    }
    void checkAndSave(plan);
  }

  const inputStyle = [
    styles.input,
    { color: c.text, borderColor: c.border, backgroundColor: c.inputBg },
  ];
  const savedFor = parseServerAddress(baseUrl)?.origin ?? baseUrl ?? 'a different address';
  const problem = failed?.problem ?? null;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {supported && (
          <>
            <View style={styles.discoverHeader}>
              <Text style={[styles.label, { color: c.text }]}>Find on your network</Text>
              <Pressable onPress={scan} hitSlop={8} disabled={scanning}>
                <View style={styles.scanAction}>
                  {scanning && <ActivityIndicator size="small" color={c.tint} />}
                  <Text style={[styles.scanText, { color: c.tint }]}>
                    {scanning ? 'Scanning…' : servers.length > 0 ? 'Rescan' : 'Scan'}
                  </Text>
                </View>
              </Pressable>
            </View>
            {servers.map((s) => {
              const selected = s.url === url;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => editUrl(s.url)}
                  // Locked while a check runs: its result is for the address
                  // and key it was started with.
                  disabled={busy}
                  accessibilityLabel={`${s.name}, ${s.secure ? 'secure' : 'not encrypted'}, ${s.url}`}
                  style={[
                    styles.serverRow,
                    { borderColor: selected ? c.tint : c.border, backgroundColor: c.inputBg },
                  ]}
                >
                  <View style={styles.serverHeader}>
                    <Text style={[styles.serverName, { color: c.text }]}>{s.name}</Text>
                    <Text
                      style={[
                        styles.badge,
                        s.secure
                          ? { color: c.tint, borderColor: c.tint }
                          : { color: c.muted, borderColor: c.border },
                      ]}
                    >
                      {s.secure ? 'Secure' : 'Not encrypted'}
                    </Text>
                  </View>
                  <Text style={[styles.serverUrl, { color: c.muted }]}>{s.url}</Text>
                </Pressable>
              );
            })}
            <Text style={[styles.hint, { color: c.muted }]}>
              {servers.length > 0
                ? 'Tap a server to use its address, enter its API key, then Save. “Secure” servers use HTTPS; “Not encrypted” is a desktop older than the secure gateway, or something else answering the scan.'
                : scanning
                  ? 'Looking for Filament DB on this network…'
                  : 'Make sure “Share on local network” is on in the desktop app and this phone is on the same Wi-Fi, then Scan.'}
            </Text>
            <Text style={[styles.label, styles.spaced, { color: c.text }]}>Server address</Text>
          </>
        )}
        {!supported && <Text style={[styles.label, { color: c.text }]}>Server address</Text>}
        <TextInput
          style={inputStyle}
          value={url}
          onChangeText={editUrl}
          editable={!busy}
          placeholder={ADDRESS_EXAMPLE}
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
        />
        <Text style={[styles.hint, { color: c.muted }]}>
          The desktop shows its address and API key under Settings → Network once “Share on local
          network” is on. A desktop older than the secure gateway uses {LEGACY_ADDRESS_EXAMPLE}{' '}
          instead.
        </Text>

        <Text style={[styles.label, styles.spaced, { color: c.text }]}>API key</Text>
        <TextInput
          style={inputStyle}
          value={keyField.value}
          onChangeText={editKey}
          editable={!busy}
          placeholder="From the desktop’s Settings → Network"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        {keyField.withheld && (
          <Text style={[styles.hint, { color: c.text }]}>
            The saved key belongs to {savedFor} and will not be sent to this address. Enter this
            server’s key.
          </Text>
        )}
        <Text style={[styles.hint, { color: c.muted }]}>
          Required for an https:// address; leave blank only for an older desktop that has none.
          Stored in the device keychain and sent only to the address above.
        </Text>

        {problem && (
          <View style={[styles.problem, { borderColor: c.danger, backgroundColor: c.card }]}>
            <Text style={[styles.problemTitle, { color: c.text }]}>{problem.title}</Text>
            <Text style={[styles.problemText, { color: c.text }]}>{problem.message}</Text>
            {problem.steps.map((step, i) => (
              <Text key={step} style={[styles.problemText, { color: c.text }]}>
                {i + 1}. {step}
              </Text>
            ))}
            {problem.caUrl && (
              <Pressable
                style={[styles.secondaryButton, { borderColor: c.tint }]}
                onPress={() => {
                  const caUrl = problem.caUrl;
                  if (!caUrl) return;
                  Linking.openURL(caUrl).catch(() =>
                    Alert.alert('Could not open the download', `Open ${caUrl} in your browser.`),
                  );
                }}
              >
                <Text style={[styles.secondaryText, { color: c.tint }]}>
                  Open the certificate download
                </Text>
              </Pressable>
            )}
            {problem.suggestedAddress && (
              <Pressable
                style={[styles.secondaryButton, { borderColor: c.tint }]}
                onPress={() => editUrl(problem.suggestedAddress ?? url)}
              >
                <Text style={[styles.secondaryText, { color: c.tint }]}>
                  Use {problem.suggestedAddress}
                </Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.secondaryButton, { borderColor: c.border }]}
              disabled={busy}
              onPress={() => failed && void persist(failed.plan)}
            >
              <Text style={[styles.secondaryText, { color: c.muted }]}>Save anyway</Text>
            </Pressable>
          </View>
        )}

        <Pressable
          style={[styles.button, { backgroundColor: c.tint }, busy && styles.disabled]}
          onPress={onSave}
          disabled={busy}
        >
          <Text style={[styles.buttonText, { color: c.onTint }]}>
            {phase === 'checking'
              ? 'Checking the connection…'
              : phase === 'saving'
                ? 'Saving…'
                : problem
                  ? 'Check again'
                  : 'Save'}
          </Text>
        </Pressable>
        <Text style={[styles.hint, styles.centeredHint, { color: c.muted }]}>
          Save checks the connection first and tells you what to fix if it fails.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  spaced: { marginTop: 18 },
  discoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  scanAction: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scanText: { fontSize: 15, fontWeight: '600' },
  serverRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    gap: 2,
  },
  serverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  serverName: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  serverUrl: { fontSize: 13 },
  badge: {
    fontSize: 12,
    fontWeight: '600',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    marginTop: 4,
  },
  hint: { fontSize: 13, marginTop: 4 },
  centeredHint: { textAlign: 'center', marginTop: 8 },
  problem: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginTop: 22,
    gap: 8,
  },
  problemTitle: { fontSize: 16, fontWeight: '600' },
  problemText: { fontSize: 14, lineHeight: 20 },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  secondaryText: { fontSize: 15, fontWeight: '600' },
  button: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 28,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
