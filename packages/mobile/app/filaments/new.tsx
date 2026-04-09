import { View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { useTheme } from "../../providers/ThemeProvider";
import { useTranslation } from "../../providers/TranslationProvider";

export default function NewFilamentScreen() {
  const { editId } = useLocalSearchParams<{ editId?: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const isEdit = !!editId;

  return (
    <>
      <Stack.Screen options={{ title: isEdit ? t("common.edit") : t("filaments.addNewTitle") }} />
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={[styles.text, { color: colors.textSecondary }]}>
          {isEdit ? "Edit Filament" : "New Filament"} form — coming soon
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center" },
  text: { fontSize: 16 },
});
