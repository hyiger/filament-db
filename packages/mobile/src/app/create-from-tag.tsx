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
  View,
} from 'react-native';

import { ApiError, createApi } from '@/lib/api';
import { clearPendingScan, peekPendingScan } from '@/lib/pendingScan';
import { useServerConfig } from '@/lib/serverConfig';
import { useColors } from '@/lib/theme';
import type { DecodedOpenPrintTag } from '@/lib/types';

/**
 * Best-effort default name from the tag — matches the server mapper
 * (decodedTagToFilament) for any tag carrying a brand/material/type. A wholly
 * empty tag yields '' here (the server defaults to "Scanned filament"); the
 * blank prefill is intentional since Create is gated on a non-empty name and
 * an `overrides.name` always wins server-side.
 */
function deriveName(tag: DecodedOpenPrintTag | null): string {
  if (!tag) return '';
  const brand = (tag.brandName ?? '').trim();
  const material = (tag.materialName ?? '').trim();
  // Filament DB tags store the full name (brand included) in materialName, so
  // only prefix the brand when it isn't already there (mirrors the server
  // mapper) — else a re-scanned FDB tag yields "Prusament Prusament PLA …".
  const combined =
    brand && material
      ? material.toLowerCase().startsWith(brand.toLowerCase())
        ? material
        : `${brand} ${material}`
      : '';
  return combined || material || brand || (tag.materialType ?? '').trim();
}

/** A one-line, read-only summary of what the tag will fill in (server-mapped). */
function tagSummary(tag: DecodedOpenPrintTag): string {
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const parts: string[] = [];
  const density = num(tag.density);
  if (density != null) parts.push(`${density} g/cm³`);
  const nozzle = num(tag.nozzleTemp);
  if (nozzle != null) parts.push(`nozzle ${nozzle}°C`);
  const bed = num(tag.bedTemp);
  if (bed != null) parts.push(`bed ${bed}°C`);
  const tags = Array.isArray(tag.tags) ? tag.tags.length : 0;
  if (tags > 0) parts.push(`${tags} tag${tags === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export default function CreateFromTagScreen() {
  const router = useRouter();
  const c = useColors();
  const { baseUrl, apiKey } = useServerConfig();
  // Read the handed-off scan in a lazy initializer. peekPendingScan does NOT
  // clear the ref, so a StrictMode / React-Compiler double-invoke of this
  // initializer stays pure (a read-and-clear would hand `null` to the second
  // call); we clear explicitly after a successful create.
  const [pending] = useState(() => peekPendingScan());
  const tag = pending?.decoded ?? null;
  const matches = pending?.matches ?? [];
  const [name, setName] = useState(() => deriveName(tag));
  const [vendor, setVendor] = useState(() => (tag?.brandName ?? '').trim());
  const [type, setType] = useState(() => (tag?.materialType ?? '').trim());
  const [saving, setSaving] = useState(false);

  if (!tag) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.text, { color: c.muted }]}>
          No scanned tag to create from. Scan a tag, then choose “Create filament”.
        </Text>
      </View>
    );
  }
  if (!baseUrl) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.text, { color: c.danger }]}>Not connected.</Text>
      </View>
    );
  }

  const canCreate = name.trim() !== '' && vendor.trim() !== '' && type.trim() !== '' && !saving;
  const swatch = tag.color || tag.secondaryColors?.[0] || '#808080';
  const summary = tagSummary(tag);

  async function create() {
    if (!tag || !baseUrl) return;
    const n = name.trim();
    const v = vendor.trim();
    const t = type.trim();
    if (!n || !v || !t) {
      Alert.alert('Missing fields', 'Name, vendor, and type are required.');
      return;
    }
    setSaving(true);
    try {
      const api = createApi({ baseUrl, apiKey });
      const created = await api.createFromTag(tag, { name: n, vendor: v, type: t });
      // Consume the hand-off now that the filament exists (explicit clear, not
      // during render). Replace so Back doesn't return to this confirm screen.
      clearPendingScan();
      router.replace({ pathname: '/filament/[id]', params: { id: created._id } });
    } catch (e) {
      Alert.alert('Create failed', e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const openMatch = (id: string) => {
    clearPendingScan();
    router.replace({ pathname: '/filament/[id]', params: { id } });
  };

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
        <View style={[styles.preview, { backgroundColor: c.card, borderColor: c.border }]}>
          <View style={[styles.swatch, { backgroundColor: swatch, borderColor: c.border }]} />
          <View style={styles.previewText}>
            <Text style={[styles.previewTitle, { color: c.text }]} numberOfLines={1}>
              {deriveName(tag) || 'Scanned tag'}
            </Text>
            {summary !== '' && (
              <Text style={[styles.previewSub, { color: c.muted }]} numberOfLines={2}>
                {summary}
              </Text>
            )}
          </View>
        </View>

        {matches.length > 0 && (
          <View style={styles.matches}>
            <Text style={[styles.label, { color: c.text }]}>Already have one of these?</Text>
            <Text style={[styles.hint, { color: c.muted }]}>
              The scan matched {matches.length === 1 ? 'an existing filament' : `${matches.length} existing filaments`}.
              Tap to open instead of creating a duplicate.
            </Text>
            {matches.map((m) => (
              <Pressable
                key={m._id}
                style={[styles.matchRow, { backgroundColor: c.card, borderColor: c.border }]}
                onPress={() => openMatch(m._id)}
              >
                <Text style={[styles.matchName, { color: c.text }]} numberOfLines={1}>
                  {m.name}
                </Text>
                {[m.vendor, m.type].filter(Boolean).length > 0 && (
                  <Text style={[styles.matchSub, { color: c.muted }]} numberOfLines={1}>
                    {[m.vendor, m.type].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </Pressable>
            ))}
            <Text style={[styles.orCreate, { color: c.text }]}>Or create a new filament from this tag:</Text>
          </View>
        )}

        <Text style={[styles.hint, { color: c.muted }]}>
          Color, temperatures, density, and tags are filled from the tag. Confirm the identity below.
        </Text>

        <Text style={[styles.label, { color: c.text }]}>Name</Text>
        <TextInput
          style={inputStyle}
          value={name}
          onChangeText={setName}
          placeholder="Filament name"
          placeholderTextColor={c.muted}
          autoCapitalize="words"
        />

        <Text style={[styles.label, styles.spaced, { color: c.text }]}>Vendor</Text>
        <TextInput
          style={inputStyle}
          value={vendor}
          onChangeText={setVendor}
          placeholder="Brand"
          placeholderTextColor={c.muted}
          autoCapitalize="words"
        />

        <Text style={[styles.label, styles.spaced, { color: c.text }]}>Type</Text>
        <TextInput
          style={inputStyle}
          value={type}
          onChangeText={setType}
          placeholder="PLA, PETG, …"
          placeholderTextColor={c.muted}
          autoCapitalize="characters"
        />

        <Pressable
          style={[styles.button, { backgroundColor: c.tint }, !canCreate && styles.disabled]}
          onPress={create}
          disabled={!canCreate}
        >
          <Text style={[styles.buttonText, { color: c.onTint }]}>
            {saving ? 'Creating…' : 'Create filament'}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  container: { padding: 20, gap: 6 },
  text: { fontSize: 16, textAlign: 'center' },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  swatch: { width: 40, height: 40, borderRadius: 20, borderWidth: 1 },
  previewText: { flex: 1, gap: 2 },
  previewTitle: { fontSize: 16, fontWeight: '600' },
  previewSub: { fontSize: 13 },
  matches: { gap: 6, marginBottom: 8 },
  matchRow: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 2,
  },
  matchName: { fontSize: 15, fontWeight: '600' },
  matchSub: { fontSize: 13 },
  orCreate: { fontSize: 14, fontWeight: '600', marginTop: 8 },
  hint: { fontSize: 13, marginBottom: 8 },
  label: { fontSize: 15, fontWeight: '600' },
  spaced: { marginTop: 14 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    marginTop: 4,
  },
  button: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 28,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
