import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
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
import type { Filament, Location, Spool } from '@/lib/types';

export default function FilamentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { baseUrl, apiKey } = useServerConfig();
  const [filament, setFilament] = useState<Filament | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (error || !baseUrl) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error ?? 'Not connected.'}</Text>
        <Pressable style={styles.retry} onPress={retry}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (!filament) {
    return (
      <View style={styles.centered}>
        <Text>Filament not found.</Text>
      </View>
    );
  }

  const api = createApi({ baseUrl, apiKey });
  const tare = filament.spoolWeight ?? 0;
  const activeSpools = (filament.spools ?? []).filter((s) => !s.retired);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.name}>{filament.name}</Text>
      <Text style={styles.sub}>{[filament.vendor, filament.type].filter(Boolean).join(' · ')}</Text>

      {activeSpools.length === 0 ? (
        <Text style={styles.muted}>No active spools on this filament.</Text>
      ) : (
        activeSpools.map((s) => (
          <SpoolRow
            key={s._id}
            api={api}
            filamentId={filament._id}
            spool={s}
            tare={tare}
            locations={locations}
            onUpdated={setFilament}
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
  onUpdated,
}: {
  api: Api;
  filamentId: string;
  spool: Spool;
  tare: number;
  locations: Location[];
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
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{spool.label || 'Spool'}</Text>

      <Text style={styles.fieldLabel}>Remaining filament (g)</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.weightInput}
          value={grams}
          onChangeText={setGrams}
          keyboardType="numeric"
          inputMode="numeric"
          placeholder="grams left"
        />
        <Pressable
          style={[styles.smallButton, saving === 'weight' && styles.disabled]}
          onPress={saveWeight}
          disabled={saving === 'weight'}
        >
          <Text style={styles.smallButtonText}>{saving === 'weight' ? '…' : 'Save'}</Text>
        </Pressable>
      </View>

      <Text style={styles.fieldLabel}>Location</Text>
      <View style={styles.chips}>
        {locations.map((loc) => {
          const active = spool.locationId === loc._id;
          return (
            <Pressable
              key={loc._id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => move(loc._id)}
              disabled={saving === loc._id}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{loc.name}</Text>
            </Pressable>
          );
        })}
        <Pressable
          style={[styles.chip, !spool.locationId && styles.chipActive]}
          onPress={() => move(null)}
          disabled={saving === 'none'}
        >
          <Text style={[styles.chipText, !spool.locationId && styles.chipTextActive]}>None</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 8 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  name: { fontSize: 22, fontWeight: '600' },
  sub: { fontSize: 15, opacity: 0.7, marginBottom: 8 },
  muted: { fontSize: 15, opacity: 0.6, marginTop: 12 },
  error: { fontSize: 15, color: '#c0392b', textAlign: 'center' },
  retry: { backgroundColor: '#208AEF', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10 },
  retryText: { color: '#fff', fontWeight: '600' },
  card: {
    borderWidth: 1,
    borderColor: '#8883',
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    gap: 8,
  },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  fieldLabel: { fontSize: 13, opacity: 0.6, marginTop: 4 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  weightInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#8884',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  smallButton: {
    backgroundColor: '#208AEF',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  smallButtonText: { color: '#fff', fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#8886',
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipActive: { backgroundColor: '#208AEF', borderColor: '#208AEF' },
  chipText: { fontSize: 14 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
