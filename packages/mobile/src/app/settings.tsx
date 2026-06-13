import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';

import { useServerConfig } from '@/lib/serverConfig';
import { useColors } from '@/lib/theme';

export default function SettingsScreen() {
  const { baseUrl, apiKey, save } = useServerConfig();
  const [url, setUrl] = useState(baseUrl ?? '');
  const [key, setKey] = useState(apiKey ?? '');
  const [saving, setSaving] = useState(false);
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
        <Text style={[styles.label, { color: c.text }]}>Server address</Text>
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
