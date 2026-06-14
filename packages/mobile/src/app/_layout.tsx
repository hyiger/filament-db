import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { createApi } from '@/lib/api';
import { ServerConfigProvider, useServerConfig } from '@/lib/serverConfig';
import { flushQueue } from '@/lib/writeQueue';

/**
 * Drains the offline write queue when the app is foregrounded (and on mount /
 * server-config change), so spool edits made offline sync app-wide — not only
 * when a filament detail screen happens to be focused. Fire-and-forget:
 * flushQueue is idempotent and guards against concurrent runs.
 */
function QueueFlusher() {
  const { baseUrl, apiKey } = useServerConfig();
  useEffect(() => {
    if (!baseUrl) return;
    const flush = () => {
      flushQueue(createApi({ baseUrl, apiKey })).catch(() => {});
    };
    flush();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') flush();
    });
    return () => sub.remove();
  }, [baseUrl, apiKey]);
  return null;
}

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ServerConfigProvider>
      <QueueFlusher />
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        {/* Minimal back button (chevron only, no previous-title label): a long
            title like "Filament DB Scanner" overflowed the nav bar's back-button
            slot and tripped a UIKit auto-layout constraint warning on iOS. */}
        <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
          <Stack.Screen name="index" options={{ title: 'Filament DB Scanner' }} />
          <Stack.Screen name="settings" options={{ title: 'Server connection' }} />
          <Stack.Screen
            name="scan-qr"
            options={{ title: 'Scan QR code', presentation: 'modal' }}
          />
          <Stack.Screen name="filament/[id]" options={{ title: 'Filament' }} />
          <Stack.Screen name="create-from-tag" options={{ title: 'New filament' }} />
        </Stack>
      </ThemeProvider>
    </ServerConfigProvider>
  );
}
