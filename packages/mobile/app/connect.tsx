import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { useTheme } from "../providers/ThemeProvider";
import { useTranslation } from "../providers/TranslationProvider";
import { useAtlas } from "../providers/AtlasProvider";
import { atlasService } from "../services/atlas";

export default function ConnectScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { config, setConfig } = useAtlas();
  const [appId, setAppId] = useState(config?.appId ?? "");
  const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
  const [testing, setTesting] = useState(false);

  const handleConnect = async () => {
    if (!appId.trim() || !apiKey.trim()) {
      Alert.alert(t("connect.error"), t("connect.fillFields"));
      return;
    }

    setTesting(true);
    try {
      await atlasService.connect(appId.trim(), apiKey.trim());
      await setConfig({ appId: appId.trim(), apiKey: apiKey.trim() });
      router.back();
    } catch (err) {
      Alert.alert(
        t("connect.error"),
        err instanceof Error ? err.message : t("connect.failedToConnect"),
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.text }]}>
          {t("connect.title")}
        </Text>
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          {t("connect.description")}
        </Text>

        <Text style={[styles.label, { color: colors.text }]}>
          {t("connect.appId")}
        </Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
          placeholder="filament-db-xxxxx"
          placeholderTextColor={colors.textSecondary}
          value={appId}
          onChangeText={setAppId}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={[styles.label, { color: colors.text }]}>
          {t("connect.apiKey")}
        </Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
          placeholder="API Key"
          placeholderTextColor={colors.textSecondary}
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.primary, opacity: testing ? 0.6 : 1 }]}
          onPress={handleConnect}
          disabled={testing}
        >
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>
            {testing ? t("connect.testing") : t("connect.connect")}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 8 },
  description: { fontSize: 15, lineHeight: 22, marginBottom: 32 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 6, marginTop: 16 },
  input: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
  },
  button: {
    marginTop: 32,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: { fontSize: 16, fontWeight: "600" },
});
