import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useServerConfig } from '@/lib/serverConfig';
import { useColors } from '@/lib/theme';
import { useServerDiscovery } from '@/lib/zeroconf';

export default function SettingsScreen() {
  const { baseUrl, apiKey, save } = useServerConfig();
  const [url, setUrl] = useState(baseUrl ?? '');
  const [key, setKey] = useState(apiKey ?? '');
  const [saving, setSaving] = useState(false);
  const { servers, scanning, supported, scan } = useServerDiscovery();
  const router = useRouter();
  const c = useColors();

  async function onSave() {
    setSaving(true);
    try {
      await save({ baseUrl: url, apiKey: key });
      router.back();
    } catch (e) {
      Alert.alert('Invalid server address', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = [
    styles.input,
    { color: c.text, borderColor: c.border, backgroundColor: c.inputBg },
  ];

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
                  onPress={() => setUrl(s.url)}
                  style={[
                    styles.serverRow,
                    { borderColor: selected ? c.tint : c.border, backgroundColor: c.inputBg },
                  ]}
                >
                  <Text style={[styles.serverName, { color: c.text }]}>{s.name}</Text>
                  <Text style={[styles.serverUrl, { color: c.muted }]}>{s.url}</Text>
                </Pressable>
              );
            })}
            <Text style={[styles.hint, { color: c.muted }]}>
              {servers.length > 0
                ? 'Tap a server to use its address, then Save.'
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
          onChangeText={setUrl}
          placeholder="http://192.168.1.50:3456"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
        />
        <Text style={[styles.hint, { color: c.muted }]}>
          The address of your Filament DB instance on the network. Desktop and dev servers use
          port 3456; Docker typically maps to 3456 as well.
        </Text>

        <Text style={[styles.label, styles.spaced, { color: c.text }]}>API key (optional)</Text>
        <TextInput
          style={inputStyle}
          value={key}
          onChangeText={setKey}
          placeholder="Only if the server sets FILAMENTDB_API_KEY"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Text style={[styles.hint, { color: c.muted }]}>
          Leave blank unless your server requires one. Sent as a bearer token and stored in the
          device keychain.
        </Text>

        <Pressable
          style={[styles.button, { backgroundColor: c.tint }, saving && styles.disabled]}
          onPress={onSave}
          disabled={saving}
        >
          <Text style={[styles.buttonText, { color: c.onTint }]}>{saving ? 'Saving…' : 'Save'}</Text>
        </Pressable>
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
  serverName: { fontSize: 16, fontWeight: '600' },
  serverUrl: { fontSize: 13 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    marginTop: 4,
  },
  hint: { fontSize: 13, marginTop: 4 },
  button: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 28,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
