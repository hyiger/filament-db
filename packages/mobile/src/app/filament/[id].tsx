import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ApiError, createApi, type Api } from '@/lib/api';
import { useServerConfig } from '@/lib/serverConfig';
import { useColors, type ThemeColors } from '@/lib/theme';
import type { Filament, Location, Spool } from '@/lib/types';

/** Human-readable rows of the filament's present properties for the detail card. */
function buildDetailRows(f: Filament): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null) => {
    if (value != null && value !== '') rows.push({ label, value });
  };
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

  const diameter = num(f.diameter);
  if (diameter != null) push('Diameter', `${diameter} mm`);
  const density = num(f.density);
  if (density != null) push('Density', `${density} g/cm³`);

  const t = f.temperatures ?? {};
  const nozzle = num(t.nozzle);
  if (nozzle != null) {
    const lo = num(t.nozzleRangeMin);
    const hi = num(t.nozzleRangeMax);
    const range = lo != null && hi != null && lo !== hi ? ` (${lo}–${hi})` : '';
    push('Nozzle', `${nozzle}°C${range}`);
  }
  const bed = num(t.bed);
  if (bed != null) push('Bed', `${bed}°C`);

  const dryT = num(f.dryingTemperature);
  if (dryT != null) {
    const mins = num(f.dryingTime);
    const hrs = mins != null ? ` for ${Math.round((mins / 60) * 10) / 10} h` : '';
    push('Drying', `${dryT}°C${hrs}`);
  }
  const shoreD = num(f.shoreHardnessD);
  const shoreA = num(f.shoreHardnessA);
  if (shoreD != null) push('Hardness', `${shoreD} Shore D`);
  else if (shoreA != null) push('Hardness', `${shoreA} Shore A`);
  const glass = num(f.glassTempTransition);
  if (glass != null) push('Glass transition', `${glass}°C`);
  const net = num(f.netFilamentWeight);
  if (net != null) push('Net weight', `${net} g`);
  const tare = num(f.spoolWeight);
  if (tare != null) push('Spool tare', `${tare} g`);
  return rows;
}

export default function FilamentDetailScreen() {
  const { id, spool: spoolParam } = useLocalSearchParams<{ id: string; spool?: string }>();
  const { baseUrl, apiKey } = useServerConfig();
  const c = useColors();
  const [filament, setFilament] = useState<Filament | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // GH #595/#693: arrived via a spool deep-link QR (`?spool=<id>`) — briefly
  // highlight that spool's card once the filament (with its spools) loads.
  const [highlightSpoolId, setHighlightSpoolId] = useState<string | null>(null);
  const deepLinkHandled = useRef(false);

  // Fetch on mount (and on Retry, which bumps reloadKey). All setState runs
  // inside the async IIFE *after* an await — never synchronously in the effect
  // body — to satisfy react-hooks/set-state-in-effect (the rule the web app
  // enforces too). The `active` flag drops a late response after unmount.
  useEffect(() => {
    if (!baseUrl || !id) return;
    let active = true;
    const api = createApi({ baseUrl, apiKey });
    (async () => {
      try {
        const [f, locs] = await Promise.all([
          api.getFilament(id),
          api.getLocations().catch(() => [] as Location[]),
        ]);
        if (!active) return;
        setFilament(f);
        setLocations(locs);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [baseUrl, apiKey, id, reloadKey]);

  const retry = () => {
    setLoading(true);
    setError(null);
    setReloadKey((k) => k + 1);
  };

  // GH #595/#693: once the filament + its spools have loaded, if the scanned URL
  // carried `?spool=<id>` matching a real spool, flag it and clear after a beat.
  // The ref fires it once (not on every later spool edit that re-sets `filament`).
  // setState is deferred via setTimeout — a synchronous set here would trip
  // react-hooks/set-state-in-effect (the rule the fetch effect above dances around).
  useEffect(() => {
    if (deepLinkHandled.current || !filament || !spoolParam) return;
    deepLinkHandled.current = true;
    if (!filament.spools?.some((s) => s._id === spoolParam)) return;
    const set = setTimeout(() => setHighlightSpoolId(spoolParam), 0);
    const clear = setTimeout(() => setHighlightSpoolId(null), 2600);
    return () => {
      clearTimeout(set);
      clearTimeout(clear);
    };
  }, [filament, spoolParam]);

  // Check "not connected"/error BEFORE the loading spinner: when no server is
  // configured the fetch effect returns early without clearing `loading` (it
  // can't setState synchronously without tripping react-hooks/set-state-in-effect),
  // so gating on `loading` first would strand a deep-linked open on a spinner
  // forever. (GH #693 review.)
  if (error || !baseUrl) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.error, { color: c.danger }]}>{error ?? 'Not connected.'}</Text>
        <Pressable style={[styles.retry, { backgroundColor: c.tint }]} onPress={retry}>
          <Text style={[styles.retryText, { color: c.onTint }]}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!filament) {
    return (
      <View style={styles.centered}>
        <Text style={{ color: c.text }}>Filament not found.</Text>
      </View>
    );
  }

  const api = createApi({ baseUrl, apiKey });
  const tare = filament.spoolWeight ?? 0;
  const allSpools = filament.spools ?? [];
  const activeSpools = allSpools.filter((s) => !s.retired);
  const retiredCount = allSpools.length - activeSpools.length;
  const detailRows = buildDetailRows(filament);
  const hasColor = !!filament.color || (filament.secondaryColors?.length ?? 0) > 0;
  const swatchColor = filament.color || filament.secondaryColors?.[0] || '#808080';

  // The spool PUT returns the RAW (unresolved) filament — for a variant that
  // inherits density / temps / weights from its parent, those come back null.
  // Keep the resolved scalar fields already in state and only swap in the
  // updated spools, so the Details card (and the tare used for remaining-weight
  // math) doesn't lose inherited values after a spool save / move.
  const handleSpoolUpdated = (updated: Filament) =>
    setFilament((prev) => (prev ? { ...prev, spools: updated.spools } : updated));

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={[styles.name, { color: c.text }]}>{filament.name}</Text>
      <Text style={[styles.sub, { color: c.muted }]}>
        {[filament.vendor, filament.type].filter(Boolean).join(' · ')}
      </Text>

      {(hasColor || detailRows.length > 0) && (
        <View style={[styles.detailCard, { backgroundColor: c.card, borderColor: c.border }]}>
          {hasColor && (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: c.muted }]}>Color</Text>
              <View style={styles.colorVal}>
                <View
                  style={[styles.detailSwatch, { backgroundColor: swatchColor, borderColor: c.border }]}
                />
                <Text style={[styles.detailValue, { color: c.text }]}>
                  {filament.colorName || filament.color || filament.secondaryColors?.[0] || '—'}
                </Text>
              </View>
            </View>
          )}
          {detailRows.map((row) => (
            <View key={row.label} style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: c.muted }]}>{row.label}</Text>
              <Text style={[styles.detailValue, { color: c.text }]}>{row.value}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={[styles.sectionHeading, { color: c.text }]}>Spools</Text>
      {activeSpools.length === 0 ? (
        <Text style={[styles.muted, { color: c.muted }]}>
          {retiredCount > 0
            ? `No active spools (${retiredCount} retired).`
            : 'No spools tracked yet on this filament.'}
        </Text>
      ) : (
        activeSpools.map((s) => (
          <SpoolRow
            key={s._id}
            api={api}
            filamentId={filament._id}
            spool={s}
            tare={tare}
            locations={locations}
            colors={c}
            highlighted={s._id === highlightSpoolId}
            onUpdated={handleSpoolUpdated}
          />
        ))
      )}
    </ScrollView>
  );
}

function SpoolRow({
  api,
  filamentId,
  spool,
  tare,
  locations,
  colors: c,
  highlighted = false,
  onUpdated,
}: {
  api: Api;
  filamentId: string;
  spool: Spool;
  tare: number;
  locations: Location[];
  colors: ThemeColors;
  highlighted?: boolean;
  onUpdated: (f: Filament) => void;
}) {
  const remaining = spool.totalWeight == null ? null : Math.max(0, Math.round(spool.totalWeight - tare));
  const [grams, setGrams] = useState(remaining == null ? '' : String(remaining));
  const [saving, setSaving] = useState<string | null>(null);

  async function saveWeight() {
    const n = Number(grams);
    if (!grams.trim() || !Number.isFinite(n) || n < 0) {
      Alert.alert('Invalid weight', 'Enter the grams of filament remaining (0 or more).');
      return;
    }
    setSaving('weight');
    try {
      onUpdated(await api.updateSpool(filamentId, spool._id, { remainingWeight: n }));
    } catch (e) {
      Alert.alert('Update failed', (e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function move(locationId: string | null) {
    setSaving(locationId ?? 'none');
    try {
      onUpdated(await api.updateSpool(filamentId, spool._id, { locationId }));
    } catch (e) {
      Alert.alert('Move failed', (e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.card, borderColor: c.border },
        highlighted && { borderColor: c.tint, backgroundColor: c.inputBg },
      ]}
    >
      <Text style={[styles.cardTitle, { color: c.text }]}>{spool.label || 'Spool'}</Text>

      <Text style={[styles.fieldLabel, { color: c.muted }]}>Remaining filament (g)</Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.weightInput, { color: c.text, borderColor: c.border, backgroundColor: c.inputBg }]}
          value={grams}
          onChangeText={setGrams}
          keyboardType="numeric"
          inputMode="numeric"
          placeholder="grams left"
          placeholderTextColor={c.muted}
        />
        <Pressable
          style={[styles.smallButton, { backgroundColor: c.tint }, saving === 'weight' && styles.disabled]}
          onPress={saveWeight}
          disabled={saving === 'weight'}
        >
          <Text style={[styles.smallButtonText, { color: c.onTint }]}>
            {saving === 'weight' ? '…' : 'Save'}
          </Text>
        </Pressable>
      </View>

      <Text style={[styles.fieldLabel, { color: c.muted }]}>Location</Text>
      <View style={styles.chips}>
        {locations.map((loc) => {
          const active = spool.locationId === loc._id;
          return (
            <Pressable
              key={loc._id}
              style={[
                styles.chip,
                { borderColor: active ? c.tint : c.border, backgroundColor: active ? c.tint : 'transparent' },
              ]}
              onPress={() => move(loc._id)}
              disabled={saving === loc._id}
            >
              <Text style={[styles.chipText, { color: active ? c.onTint : c.text }]}>{loc.name}</Text>
            </Pressable>
          );
        })}
        <Pressable
          style={[
            styles.chip,
            {
              borderColor: !spool.locationId ? c.tint : c.border,
              backgroundColor: !spool.locationId ? c.tint : 'transparent',
            },
          ]}
          onPress={() => move(null)}
          disabled={saving === 'none'}
        >
          <Text style={[styles.chipText, { color: !spool.locationId ? c.onTint : c.text }]}>None</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 8 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  name: { fontSize: 22, fontWeight: '600' },
  sub: { fontSize: 15, marginBottom: 8 },
  muted: { fontSize: 15, marginTop: 12 },
  detailCard: { borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 4, gap: 10 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  detailLabel: { fontSize: 14 },
  detailValue: { fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  colorVal: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  detailSwatch: { width: 18, height: 18, borderRadius: 9, borderWidth: 1 },
  sectionHeading: { fontSize: 17, fontWeight: '600', marginTop: 20 },
  error: { fontSize: 15, textAlign: 'center' },
  retry: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10 },
  retryText: { fontWeight: '600' },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    gap: 8,
  },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  fieldLabel: { fontSize: 13, marginTop: 4 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  weightInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  smallButton: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  smallButtonText: { fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipText: { fontSize: 14 },
  disabled: { opacity: 0.5 },
});
