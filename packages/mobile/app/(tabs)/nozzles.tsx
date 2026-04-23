import { useState, useEffect, useCallback } from "react";
import { View, Text, FlatList, TouchableOpacity, RefreshControl, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useTheme } from "../../providers/ThemeProvider";
import { useTranslation } from "../../providers/TranslationProvider";
import { useAtlas } from "../../providers/AtlasProvider";
import type { NozzleDetail } from "@filament-db/shared/types/nozzle";
import { atlasService } from "../../services/atlas";

export default function NozzlesTab() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isConnected } = useAtlas();
  const [nozzles, setNozzles] = useState<NozzleDetail[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadNozzles = useCallback(async () => {
    if (!isConnected) return;
    try {
      const data = await atlasService.nozzles.list();
      setNozzles(data);
    } catch (err) {
      console.error("Failed to load nozzles:", err);
    } finally {
      setLoading(false);
    }
  }, [isConnected]);

  useEffect(() => {
    // Standard fetch-on-mount: loadNozzles setStates synchronously before
    // awaiting, which trips the rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadNozzles();
  }, [loadNozzles]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadNozzles();
    setRefreshing(false);
  }, [loadNozzles]);

  const renderNozzle = ({ item }: { item: NozzleDetail }) => (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
      onPress={() => router.push(`/nozzles/${item._id}`)}
    >
      <View style={styles.rowContent}>
        <Text style={[styles.name, { color: colors.text }]}>{item.name}</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {item.diameter}mm · {item.type}
          {item.highFlow ? " · HF" : ""}
          {item.hardened ? " · Hardened" : ""}
        </Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={nozzles}
        keyExtractor={(item) => item._id}
        renderItem={renderNozzle}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          !loading ? (
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t("nozzles.empty")}
            </Text>
          ) : null
        }
        contentContainerStyle={nozzles.length === 0 ? styles.emptyList : undefined}
      />
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.primary }]}
        onPress={() => router.push("/nozzles/new")}
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  rowContent: { flex: 1 },
  name: { fontSize: 16, fontWeight: "600" },
  subtitle: { fontSize: 13, marginTop: 2 },
  emptyText: { fontSize: 16, textAlign: "center", marginTop: 48 },
  emptyList: { flex: 1, justifyContent: "center" },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabText: { color: "#fff", fontSize: 28, fontWeight: "300", marginTop: -2 },
});
