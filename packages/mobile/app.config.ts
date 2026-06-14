import type { ExpoConfig } from 'expo/config';

/**
 * NFC is gated behind EXPO_PUBLIC_ENABLE_NFC so the app can be built on a free
 * Apple ID, which cannot provision the Core NFC "Tag Reading" entitlement.
 *
 *   default / unset           → NFC enabled (the real product build)
 *   EXPO_PUBLIC_ENABLE_NFC=0   → QR-only build, no NFC entitlement
 *
 * e.g. a free-account dev build:  EXPO_PUBLIC_ENABLE_NFC=0 npx expo run:ios
 *
 * The same EXPO_PUBLIC_ flag is read at runtime (src/lib/features.ts) to hide
 * the NFC entry points, so a QR-only build looks intentional rather than broken.
 */
const nfcEnabled = process.env.EXPO_PUBLIC_ENABLE_NFC !== '0';

const plugins: NonNullable<ExpoConfig['plugins']> = [
  'expo-router',
  [
    'expo-splash-screen',
    {
      backgroundColor: '#208AEF',
      android: { image: './assets/images/splash-icon.png', imageWidth: 76 },
    },
  ],
  [
    'expo-camera',
    { cameraPermission: 'Filament DB uses the camera to scan QR codes on spool labels.' },
  ],
  'expo-secure-store',
  [
    // Android 9+ blocks cleartext http by default; the app reaches a self-hosted
    // Filament DB over http on the LAN, so allow cleartext. (usesCleartextTraffic
    // isn't a typed Expo android.* key — it must go through this plugin. The
    // user-entered URL is http(s)-validated and the bearer key is the auth, so
    // this isn't a blanket "trust any http". GH #693 review.)
    'expo-build-properties',
    { android: { usesCleartextTraffic: true } },
  ],
];

if (nfcEnabled) {
  plugins.push([
    'react-native-nfc-manager',
    {
      nfcPermission:
        'Filament DB reads NFC filament spool tags (OpenPrintTag) to look them up in your database.',
      includeNdefEntitlement: true,
    },
  ]);
}

const config: ExpoConfig = {
  name: 'Filament DB Scanner',
  slug: 'filament-db-scanner',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'filamentdb',
  userInterfaceStyle: 'automatic',
  ios: {
    icon: './assets/expo.icon',
    bundleIdentifier: 'com.filamentdb.scanner',
    supportsTablet: true,
    infoPlist: {
      // The app talks to a self-hosted Filament DB over http on the local
      // network (e.g. http://192.168.1.50:3456). App Transport Security blocks
      // plain http in release builds, so scope an exception to local networking
      // only — NOT NSAllowsArbitraryLoads, which would weaken ATS for the whole
      // internet. (Matches the value Expo's prebuild template already bakes into
      // Info.plist; pinned here so it survives template changes. GH #693 review.)
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
      // mDNS auto-discovery (react-native-zeroconf). iOS 14+ requires every
      // Bonjour service type the app browses to be declared here, plus a
      // local-network usage description for the permission prompt. The desktop
      // app advertises `_filamentdb._tcp` when "Share on local network" is on.
      NSBonjourServices: ['_filamentdb._tcp'],
      NSLocalNetworkUsageDescription:
        'Filament DB looks for your Filament DB desktop app on this network so you can connect without typing its address.',
    },
  },
  android: {
    package: 'com.filamentdb.scanner',
    // mDNS auto-discovery (react-native-zeroconf / NsdManager). INTERNET is
    // added by default; the multicast + network/wifi-state perms are needed to
    // browse Bonjour services on the LAN. `android.permissions` is additive.
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.CHANGE_WIFI_MULTICAST_STATE',
    ],
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: { output: 'static', favicon: './assets/images/favicon.png' },
  plugins,
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;
