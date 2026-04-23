import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ThemeProvider, useTheme } from "../providers/ThemeProvider";
import { TranslationProvider } from "../providers/TranslationProvider";
import { AtlasProvider } from "../providers/AtlasProvider";

function RootLayoutInner() {
  const { theme } = useTheme();

  return (
    <>
      <StatusBar style={theme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: {
            backgroundColor: theme === "dark" ? "#111827" : "#ffffff",
          },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ presentation: "modal", headerShown: true, title: "Connect to Atlas" }} />
        <Stack.Screen name="filaments/[id]" options={{ headerShown: true, title: "Filament" }} />
        <Stack.Screen name="filaments/new" options={{ headerShown: true, title: "New Filament" }} />
        <Stack.Screen name="nozzles/[id]" options={{ headerShown: true, title: "Nozzle" }} />
        <Stack.Screen name="nozzles/new" options={{ headerShown: true, title: "New Nozzle" }} />
        <Stack.Screen name="printers/[id]" options={{ headerShown: true, title: "Printer" }} />
        <Stack.Screen name="printers/new" options={{ headerShown: true, title: "New Printer" }} />
        <Stack.Screen name="nfc/read" options={{ presentation: "modal", headerShown: true, title: "Read NFC Tag" }} />
        <Stack.Screen name="nfc/write" options={{ presentation: "modal", headerShown: true, title: "Write NFC Tag" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <TranslationProvider>
        <AtlasProvider>
          <RootLayoutInner />
        </AtlasProvider>
      </TranslationProvider>
    </ThemeProvider>
  );
}
