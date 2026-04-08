import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { useTheme } from "../../providers/ThemeProvider";
import { useTranslation } from "../../providers/TranslationProvider";
import { useAtlas } from "../../providers/AtlasProvider";
import type { FilamentSummary } from "@filament-db/shared/types/filament";
import { atlasService } from "../../services/atlas";

export default function FilamentsTab() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isConnected } = useAtlas();
  const [filaments, setFilaments] = useState<FilamentSummary[]>([]);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadFilaments = useCallback(async () => {
    if (!isConnected) return;
    try {
      const data = await atlasService.filaments.list(search ? { search } : undefined);
      setFilaments(data);
    } catch (err) {
      console.error("Failed to load filaments:", err);
    } finally {
      setLoading(false);
    }
  }, [isConnected, search]);

  useEffect(() => {
    loadFilaments();
  }, [loadFilaments]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFilaments();
    setRefreshing(false);
  }, [loadFilaments]);

  if (!isConnected) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          {t("connect.notConnected")}
        </Text>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={() => router.push("/connect")}
        >
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>
            {t("connect.setup")}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  const renderFilament = ({ item }: { item: FilamentSummary }) => (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
      onPress={() => router.push(`/filaments/${item._id}`)}
    >
      <View style={[styles.colorSwatch, { backgroundColor: item.color || "#808080" }]} />
      <View style={styles.rowContent}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {item.vendor} · {item.type}
        </Text>
      </View>
      {item.spools?.length > 0 && (
        <View style={[styles.badge, { backgroundColor: colors.primary }]}>
          <Text style={styles.badgeText}>{item.spools.length}</Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TextInput
        style={[styles.searchInput, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
        placeholder={t("filaments.search")}
        placeholderTextColor={colors.textSecondary}
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={loadFilaments}
        returnKeyType="search"
      />
      <FlatList
        data={filaments}
        keyExtractor={(item) => item._id}
        renderItem={renderFilament}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          !loading ? (
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t("filaments.empty")}
            </Text>
          ) : null
        }
        contentContainerStyle={filaments.length === 0 ? styles.emptyList : undefined}
      />
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.primary }]}
        onPress={() => router.push("/filaments/new")}
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  searchInput: {
    margin: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  colorSwatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: 12,
  },
  rowContent: { flex: 1 },
  name: { fontSize: 16, fontWeight: "600" },
  subtitle: { fontSize: 13, marginTop: 2 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
  },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  emptyText: { fontSize: 16, textAlign: "center", marginTop: 48 },
  emptyList: { flex: 1, justifyContent: "center" },
  button: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: { fontSize: 16, fontWeight: "600" },
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
