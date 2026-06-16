import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
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
import {
  flushQueue,
  pendingCount,
  submitWrite,
  subscribePending,
  type WriteOp,
} from '@/lib/writeQueue';

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

/** Track the live offline-queue pending count and flush on screen focus. */
function usePendingSync(api: Api | null, setReloadKey: React.Dispatch<React.SetStateAction<number>>): number {
  const [pending, setPending] = useState(0);
  const prevPending = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read initial count after mount (async IIFE — state set after await, not
  // synchronously). Then track changes: a DROP means a flush applied writes —
  // including the app-wide foreground flusher in _layout, which doesn't itself
  // tell this screen to reload (Codex P2) — so re-fetch to show the synced
  // server state rather than just clearing the pill. An increase is an enqueue,
  // already reflected locally by the optimistic patch, so no re-fetch.
  useEffect(() => {
    let active = true;
    (async () => {
      const count = await pendingCount();
      if (active) {
        prevPending.current = count;
        setPending(count);
      }
    })();
    const unsub = subscribePending((count) => {
      // A multi-item flush drops the count once per entry; DEBOUNCE the refetch
      // so a reconnect with many queued writes coalesces into a single reload
      // after the flush settles, not one API burst per item (Codex P2).
      if (count < prevPending.current) {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => setReloadKey((k) => k + 1), 500);
      }
      prevPending.current = count;
      setPending(count);
    });
    return () => {
      active = false;
      unsub();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, [setReloadKey]);

  // Drain on focus; the subscriber above re-fetches on the resulting count drop.
  useFocusEffect(
    useCallback(() => {
      if (api) flushQueue(api).catch(() => {});
    }, [api]),
  );

  return pending;
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
  // Show retired spools too (so the Un-retire action is reachable, Codex P2).
  const [showRetired, setShowRetired] = useState(false);
  // GH #595/#693: arrived via a spool deep-link QR (`?spool=<id>`) — briefly
  // highlight that spool's card once the filament (with its spools) loads.
  const [highlightSpoolId, setHighlightSpoolId] = useState<string | null>(null);
  const deepLinkHandled = useRef(false);
  // Feature A: scroll-to-spool support.
  const scrollRef = useRef<ScrollView>(null);
  const scrolledToSpool = useRef(false);

  // Build the api instance once baseUrl is known (used by usePendingSync too).
  // Memoized so its identity is stable across renders — the focus-effect and
  // the SpoolRow `api` prop depend on it, and a fresh object each render would
  // re-subscribe / re-render needlessly.
  const api = useMemo(
    () => (baseUrl ? createApi({ baseUrl, apiKey }) : null),
    [baseUrl, apiKey],
  );

  // Feature C: pending-sync count + flush-on-focus.
  const pending = usePendingSync(api, setReloadKey);

  // Fetch on mount (and on Retry, which bumps reloadKey). All setState runs
  // inside the async IIFE *after* an await — never synchronously in the effect
  // body — to satisfy react-hooks/set-state-in-effect (the rule the web app
  // enforces too). The `active` flag drops a late response after unmount.
  useEffect(() => {
    if (!baseUrl || !id) return;
    let active = true;
    const fetchApi = createApi({ baseUrl, apiKey });
    (async () => {
      try {
        const [f, locs] = await Promise.all([
          fetchApi.getFilament(id),
          fetchApi.getLocations().catch(() => [] as Location[]),
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
    // Feature A: include retired spools in the check too.
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

  const tare = filament.spoolWeight ?? 0;
  const allSpools = filament.spools ?? [];
  const activeSpools = allSpools.filter((s) => !s.retired);
  const retiredCount = allSpools.length - activeSpools.length;
  const detailRows = buildDetailRows(filament);
  const hasColor = !!filament.color || (filament.secondaryColors?.length ?? 0) > 0;
  const swatchColor = filament.color || filament.secondaryColors?.[0] || '#808080';

  // Which spools to render: active ones, plus retired ones when the user has
  // toggled them on (so Un-retire is reachable, Codex P2), plus a retired
  // deep-link target even when the toggle is off (Feature A).
  const deepLinkedSpool = spoolParam ? allSpools.find((s) => s._id === spoolParam) : undefined;
  const deepLinkedIsRetiredExtra =
    !showRetired &&
    deepLinkedSpool?.retired &&
    !activeSpools.some((s) => s._id === spoolParam);
  const spoolsToRender: Spool[] = showRetired
    ? allSpools
    : deepLinkedIsRetiredExtra
      ? [...activeSpools, deepLinkedSpool as Spool]
      : activeSpools;

  // The spool PUT returns the RAW (unresolved) filament — for a variant that
  // inherits density / temps / weights from its parent, those come back null.
  // Keep the resolved scalar fields already in state and only swap in the
  // updated spools, so the Details card (and the tare used for remaining-weight
  // math) doesn't lose inherited values after a spool save / move.
  const handleSpoolUpdated = (updated: Filament) =>
    setFilament((prev) => (prev ? { ...prev, spools: updated.spools } : updated));

  // Feature C: optimistic local patch (no server round-trip needed for the UI).
  const handleLocalPatch = (spoolId: string, patch: Partial<Spool>) => {
    setFilament((prev) =>
      prev
        ? { ...prev, spools: prev.spools?.map((s) => (s._id === spoolId ? { ...s, ...patch } : s)) }
        : prev,
    );
  };

  return (
    <ScrollView ref={scrollRef} contentContainerStyle={styles.container}>
      <Text style={[styles.name, { color: c.text }]}>{filament.name}</Text>
      <Text style={[styles.sub, { color: c.muted }]}>
        {[filament.vendor, filament.type].filter(Boolean).join(' · ')}
      </Text>

      {/* Feature C: pending-sync pill */}
      {pending > 0 && (
        <View style={[styles.pendingPill, { borderColor: c.border }]}>
          <Text style={[styles.pendingPillText, { color: c.muted }]}>
            {pending} change{pending === 1 ? '' : 's'} pending sync
          </Text>
        </View>
      )}

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
      {spoolsToRender.length === 0 ? (
        <Text style={[styles.muted, { color: c.muted }]}>
          {retiredCount > 0
            ? `No active spools (${retiredCount} retired).`
            : 'No spools tracked yet on this filament.'}
        </Text>
      ) : (
        spoolsToRender.map((s) => {
          const isHighlighted = s._id === highlightSpoolId;
          // Scroll to the DEEP-LINK TARGET row, not the highlighted one: the
          // highlight is set after first render and only changes colors, so RN
          // wouldn't re-fire layout — the scroll would never run for a spool
          // below the fold. Keying on spoolParam attaches onLayout from the
          // first render, so it fires on mount (Codex P2).
          const isDeepLinkTarget = !!spoolParam && s._id === spoolParam;
          return (
            <SpoolRow
              key={s._id}
              api={api as Api}
              filamentId={filament._id}
              spool={s}
              tare={tare}
              locations={locations}
              colors={c}
              highlighted={isHighlighted}
              onUpdated={handleSpoolUpdated}
              onLocalPatch={handleLocalPatch}
              onLayoutY={
                isDeepLinkTarget
                  ? (y) => {
                      if (!scrolledToSpool.current) {
                        scrolledToSpool.current = true;
                        scrollRef.current?.scrollTo({ y, animated: true });
                      }
                    }
                  : undefined
              }
            />
          );
        })
      )}

      {retiredCount > 0 && (
        <Pressable
          style={[styles.retiredToggle, { borderColor: c.border }]}
          onPress={() => setShowRetired((v) => !v)}
        >
          <Text style={[styles.retiredToggleText, { color: c.muted }]}>
            {showRetired ? 'Hide retired' : `Show ${retiredCount} retired`}
          </Text>
        </Pressable>
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
  onLocalPatch,
  onLayoutY,
}: {
  api: Api;
  filamentId: string;
  spool: Spool;
  tare: number;
  locations: Location[];
  colors: ThemeColors;
  highlighted?: boolean;
  onUpdated: (f: Filament) => void;
  onLocalPatch: (spoolId: string, patch: Partial<Spool>) => void;
  onLayoutY?: (y: number) => void;
}) {
  const remaining = spool.totalWeight == null ? null : Math.max(0, Math.round(spool.totalWeight - tare));
  const [grams, setGrams] = useState(remaining == null ? '' : String(remaining));
  const [saving, setSaving] = useState<string | null>(null);
  // Feature B: log usage input state.
  const [usageGrams, setUsageGrams] = useState('');
  // Feature B: dry-cycle inputs (at least one required so an accidental tap
  // can't log a blank cycle and reset dry-due tracking — Codex P2).
  const [dryTemp, setDryTemp] = useState('');
  const [dryDuration, setDryDuration] = useState('');

  /** Feature C: route every spool mutation through the offline write queue.
   * Returns `{ ok }` — false on a real server error so callers can keep the
   * user's input to retry — and the server's `filament` when it went through
   * live (callers refresh from the authoritative state rather than props). */
  async function runWrite(
    saveKey: string,
    label: string,
    write: WriteOp,
    optimisticPatch: Partial<Spool>,
  ): Promise<{ ok: boolean; filament?: Filament }> {
    setSaving(saveKey);
    try {
      const result = await submitWrite(api, { filamentId, spoolId: spool._id, label, write });
      if (result.queued) {
        onLocalPatch(spool._id, optimisticPatch);
        Alert.alert('Saved offline', 'This change will sync when the server is reachable.');
        return { ok: true };
      }
      const f = result.result as Filament;
      onUpdated(f);
      return { ok: true, filament: f };
    } catch (e) {
      Alert.alert('Update failed', (e as Error).message);
      return { ok: false };
    } finally {
      setSaving(null);
    }
  }

  async function saveWeight() {
    const n = Number(grams);
    if (!grams.trim() || !Number.isFinite(n) || n < 0) {
      Alert.alert('Invalid weight', 'Enter the grams of filament remaining (0 or more).');
      return;
    }
    await runWrite(
      'weight',
      `Set remaining to ${n} g`,
      { kind: 'updateSpool', patch: { remainingWeight: n } },
      { totalWeight: n + tare },
    );
  }

  async function move(locationId: string | null, locationName?: string) {
    await runWrite(
      locationId ?? 'none',
      locationId ? `Move to ${locationName ?? 'location'}` : 'Clear location',
      { kind: 'updateSpool', patch: { locationId } },
      { locationId },
    );
  }

  // Feature B: retire / un-retire toggle.
  async function toggleRetire() {
    const newRetired = !spool.retired;
    await runWrite(
      'retire',
      newRetired ? 'Retire spool' : 'Un-retire spool',
      { kind: 'updateSpool', patch: { retired: newRetired } },
      { retired: newRetired },
    );
  }

  // Feature B: log usage.
  async function logUsage() {
    const g = Number(usageGrams);
    if (!usageGrams.trim() || !Number.isFinite(g) || g <= 0) {
      Alert.alert('Invalid amount', 'Enter a positive number of grams used.');
      return;
    }
    const optimisticTotalWeight =
      spool.totalWeight == null ? undefined : Math.max(0, spool.totalWeight - g);
    const optimisticPatch: Partial<Spool> =
      optimisticTotalWeight !== undefined ? { totalWeight: optimisticTotalWeight } : {};
    const res = await runWrite(
      'usage',
      `Use ${g} g`,
      { kind: 'logUsage', grams: g },
      optimisticPatch,
    );
    if (res.ok) {
      setUsageGrams('');
      // Refresh the remaining-weight field from the SERVER's authoritative
      // spool, not the pre-request value — the weight may have changed
      // server-side since this screen loaded (another device / print history),
      // and a stale value would be written back on a later Save (Codex P2).
      // Usage is online-only (never queued), so res.filament is present.
      const updated = res.filament?.spools?.find((sp) => sp._id === spool._id);
      if (updated?.totalWeight != null) {
        setGrams(String(Math.max(0, Math.round(updated.totalWeight - tare))));
      }
    }
  }

  // Feature B: log dry cycle.
  async function logDryCycle() {
    const t = dryTemp.trim() ? Number(dryTemp) : null;
    const d = dryDuration.trim() ? Number(dryDuration) : null;
    // Require at least one detail — a blank cycle would still stamp a date and
    // mark the spool freshly dried on the dashboard (Codex P2).
    if (t == null && d == null) {
      Alert.alert('Add a detail', 'Enter a temperature (°C) or duration (min) for the dry cycle.');
      return;
    }
    if (t != null && (!Number.isFinite(t) || t < 0 || t > 300)) {
      Alert.alert('Invalid temperature', 'Temperature must be between 0 and 300 °C.');
      return;
    }
    if (d != null && (!Number.isFinite(d) || d < 0)) {
      Alert.alert('Invalid duration', 'Duration must be 0 minutes or more.');
      return;
    }
    const cycle: { tempC?: number; durationMin?: number } = {};
    if (t != null) cycle.tempC = t;
    if (d != null) cycle.durationMin = d;
    const res = await runWrite('dry', 'Log dry cycle', { kind: 'logDryCycle', cycle }, {});
    if (res.ok) {
      setDryTemp('');
      setDryDuration('');
    }
  }

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.card, borderColor: c.border },
        highlighted && { borderColor: c.tint, backgroundColor: c.inputBg },
      ]}
      onLayout={onLayoutY ? (e) => onLayoutY(e.nativeEvent.layout.y) : undefined}
    >
      <Text style={[styles.cardTitle, { color: c.text }]}>
        {spool.label || spool.instanceId || 'Spool'}
        {spool.retired ? <Text style={{ color: c.muted, fontWeight: '400' }}> · retired</Text> : null}
      </Text>
      {/* #732: surface the durable per-spool id so a scanned spool is verifiable. */}
      {spool.instanceId ? (
        <Text style={[styles.spoolId, { color: c.muted }]} selectable>
          ID {spool.instanceId}
        </Text>
      ) : null}

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
          disabled={saving !== null}
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
              onPress={() => move(loc._id, loc.name)}
              disabled={saving !== null}
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
          disabled={saving !== null}
        >
          <Text style={[styles.chipText, { color: !spool.locationId ? c.onTint : c.text }]}>None</Text>
        </Pressable>
      </View>

      {/* Feature B: inventory actions */}
      <View style={[styles.divider, { borderColor: c.border }]} />

      {/* Retire / Un-retire */}
      <Pressable
        style={[
          styles.smallButton,
          styles.actionButton,
          { backgroundColor: spool.retired ? c.tint : c.card, borderColor: c.border },
          saving === 'retire' && styles.disabled,
        ]}
        onPress={toggleRetire}
        disabled={saving !== null}
      >
        <Text style={[styles.smallButtonText, { color: spool.retired ? c.onTint : c.text }]}>
          {saving === 'retire' ? '…' : spool.retired ? 'Un-retire' : 'Retire'}
        </Text>
      </Pressable>

      {/* Log usage */}
      <Text style={[styles.fieldLabel, { color: c.muted }]}>Log usage (g)</Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.weightInput, { color: c.text, borderColor: c.border, backgroundColor: c.inputBg }]}
          value={usageGrams}
          onChangeText={setUsageGrams}
          keyboardType="numeric"
          inputMode="numeric"
          placeholder="grams used"
          placeholderTextColor={c.muted}
        />
        <Pressable
          style={[styles.smallButton, { backgroundColor: c.tint }, saving === 'usage' && styles.disabled]}
          onPress={logUsage}
          disabled={saving !== null}
        >
          <Text style={[styles.smallButtonText, { color: c.onTint }]}>
            {saving === 'usage' ? '…' : 'Log'}
          </Text>
        </Pressable>
      </View>

      {/* Log dry cycle — temp and/or duration (at least one required) */}
      <Text style={[styles.fieldLabel, { color: c.muted }]}>Log dry cycle</Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.dryInput, { color: c.text, borderColor: c.border, backgroundColor: c.inputBg }]}
          value={dryTemp}
          onChangeText={setDryTemp}
          keyboardType="numeric"
          inputMode="numeric"
          placeholder="°C"
          placeholderTextColor={c.muted}
        />
        <TextInput
          style={[styles.dryInput, { color: c.text, borderColor: c.border, backgroundColor: c.inputBg }]}
          value={dryDuration}
          onChangeText={setDryDuration}
          keyboardType="numeric"
          inputMode="numeric"
          placeholder="min"
          placeholderTextColor={c.muted}
        />
        <Pressable
          style={[styles.smallButton, { backgroundColor: c.tint }, saving === 'dry' && styles.disabled]}
          onPress={logDryCycle}
          disabled={saving !== null}
        >
          <Text style={[styles.smallButtonText, { color: c.onTint }]}>
            {saving === 'dry' ? '…' : 'Log'}
          </Text>
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
  spoolId: { fontSize: 12, marginTop: 2, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) },
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
  dryInput: {
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
  retiredToggle: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    marginTop: 14,
  },
  retiredToggleText: { fontSize: 14, fontWeight: '600' },
  pendingPill: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  pendingPillText: { fontSize: 13 },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
  actionButton: {
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
});
