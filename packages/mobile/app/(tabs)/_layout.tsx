import { Tabs } from "expo-router";
import { useTheme } from "../../providers/ThemeProvider";
import { useTranslation } from "../../providers/TranslationProvider";

// Simple icon components using Unicode symbols
function TabIcon({ symbol, color }: { symbol: string; color: string }) {
  return (
    <__Text style={{ fontSize: 24, color }}>{symbol}</__Text>
  );
}

// Minimal Text import for tab icons
import { Text as __Text } from "react-native";

export default function TabLayout() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.tabIconSelected,
        tabBarInactiveTintColor: colors.tabIconDefault,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
        },
        headerStyle: {
          backgroundColor: colors.background,
        },
        headerTintColor: colors.text,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("nav.filaments"),
          tabBarIcon: ({ color }) => <TabIcon symbol="🧵" color={color} />,
        }}
      />
      <Tabs.Screen
        name="nozzles"
        options={{
          title: t("nav.nozzles"),
          tabBarIcon: ({ color }) => <TabIcon symbol="⦿" color={color} />,
        }}
      />
      <Tabs.Screen
        name="printers"
        options={{
          title: t("nav.printers"),
          tabBarIcon: ({ color }) => <TabIcon symbol="🖨" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t("nav.settings"),
          tabBarIcon: ({ color }) => <TabIcon symbol="⚙" color={color} />,
        }}
      />
    </Tabs>
  );
}
