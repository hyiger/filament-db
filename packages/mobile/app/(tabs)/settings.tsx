import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { useTheme } from "../../providers/ThemeProvider";
import { useTranslation } from "../../providers/TranslationProvider";
import { useAtlas } from "../../providers/AtlasProvider";
import { LOCALES } from "@filament-db/shared/i18n";
import type { Locale } from "@filament-db/shared/i18n";

export default function SettingsTab() {
  const router = useRouter();
  const { colors, mode, setMode, theme } = useTheme();
  const { locale, setLocale, t } = useTranslation();
  const { isConnected, config, clearConfig } = useAtlas();

  const themeOptions = [
    { key: "system" as const, label: t("settings.theme.system") },
    { key: "light" as const, label: t("settings.theme.light") },
    { key: "dark" as const, label: t("settings.theme.dark") },
  ];

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Atlas Connection */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t("settings.atlas.title")}
      </Text>
      <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.settingRow}>
          <Text style={[styles.label, { color: colors.text }]}>{t("settings.atlas.status")}</Text>
          <Text style={{ color: isConnected ? colors.success : colors.danger }}>
            {isConnected ? t("settings.atlas.connected") : t("settings.atlas.disconnected")}
          </Text>
        </View>
        {isConnected && config && (
          <View style={styles.settingRow}>
            <Text style={[styles.label, { color: colors.text }]}>{t("settings.atlas.appId")}</Text>
            <Text style={[styles.value, { color: colors.textSecondary }]} numberOfLines={1}>
              {config.appId}
            </Text>
          </View>
        )}
        <TouchableOpacity
          style={[styles.linkRow, { borderTopColor: colors.border }]}
          onPress={() => router.push("/connect")}
        >
          <Text style={{ color: colors.primary }}>
            {isConnected ? t("settings.atlas.change") : t("settings.atlas.connect")}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Language */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t("settings.language")}
      </Text>
      <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.toggleRow}>
          {LOCALES.map((l) => (
            <TouchableOpacity
              key={l.code}
              style={[
                styles.toggleButton,
                {
                  backgroundColor: locale === l.code ? colors.primary : "transparent",
                  borderColor: colors.border,
                },
              ]}
              onPress={() => setLocale(l.code as Locale)}
            >
              <Text
                style={{
                  color: locale === l.code ? colors.primaryText : colors.text,
                  fontWeight: locale === l.code ? "600" : "400",
                }}
              >
                {l.nativeName}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Theme */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t("settings.theme.title")}
      </Text>
      <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.toggleRow}>
          {themeOptions.map((opt) => (
            <TouchableOpacity
              key={opt.key}
              style={[
                styles.toggleButton,
                {
                  backgroundColor: mode === opt.key ? colors.primary : "transparent",
                  borderColor: colors.border,
                },
              ]}
              onPress={() => setMode(opt.key)}
            >
              <Text
                style={{
                  color: mode === opt.key ? colors.primaryText : colors.text,
                  fontWeight: mode === opt.key ? "600" : "400",
                }}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* NFC */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>NFC</Text>
      <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <TouchableOpacity
          style={styles.linkRow}
          onPress={() => router.push("/nfc/read")}
        >
          <Text style={{ color: colors.primary }}>{t("nfc.readTag")}</Text>
        </TouchableOpacity>
      </View>

      {/* About */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t("settings.about")}
      </Text>
      <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.settingRow}>
          <Text style={[styles.label, { color: colors.text }]}>{t("settings.version")}</Text>
          <Text style={[styles.value, { color: colors.textSecondary }]}>
            {Constants.expoConfig?.version ?? "1.0.0"}
          </Text>
        </View>
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 24,
    marginLeft: 4,
  },
  section: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  settingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  linkRow: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
  },
  label: { fontSize: 16 },
  value: { fontSize: 14 },
  toggleRow: {
    flexDirection: "row",
    padding: 8,
    gap: 8,
  },
  toggleButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
  },
});
