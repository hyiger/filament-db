import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { ServerConfigProvider } from '@/lib/serverConfig';

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ServerConfigProvider>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="index" options={{ title: 'Filament DB Scanner' }} />
          <Stack.Screen name="settings" options={{ title: 'Server connection' }} />
          <Stack.Screen
            name="scan-qr"
            options={{ title: 'Scan QR code', presentation: 'modal' }}
          />
          <Stack.Screen name="filament/[id]" options={{ title: 'Filament' }} />
        </Stack>
      </ThemeProvider>
    </ServerConfigProvider>
  );
}
