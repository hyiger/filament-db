import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import * as SecureStore from "expo-secure-store";
import { atlasService } from "../services/atlas";

interface AtlasConfig {
  appId: string;
  apiKey: string;
}

interface AtlasContextValue {
  config: AtlasConfig | null;
  isConnected: boolean;
  /** True while the on-mount restore attempt is in-flight. Lets consumers
   * differentiate "not connected" from "haven't tried yet" so they don't
   * flash a setup screen during the cold-start reconnect. */
  isRestoring: boolean;
  setConfig: (config: AtlasConfig) => Promise<void>;
  clearConfig: () => Promise<void>;
}

const STORAGE_KEY_APP_ID = "filamentdb-atlas-app-id";
const STORAGE_KEY_API_KEY = "filamentdb-atlas-api-key";

const AtlasContext = createContext<AtlasContextValue>({
  config: null,
  isConnected: false,
  isRestoring: false,
  setConfig: async () => {},
  clearConfig: async () => {},
});

export function AtlasProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<AtlasConfig | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);

  // On mount, pull credentials out of SecureStore and reconnect to Atlas.
  // Without this the user has to re-enter their App ID + API key on every
  // cold launch — the connect screen wrote them to SecureStore but nothing
  // ever read them back. Failures (network, revoked key) leave isConnected
  // false; the connect screen is the recovery path.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [appId, apiKey] = await Promise.all([
          SecureStore.getItemAsync(STORAGE_KEY_APP_ID),
          SecureStore.getItemAsync(STORAGE_KEY_API_KEY),
        ]);
        if (cancelled) return;
        if (appId && apiKey) {
          try {
            await atlasService.connect(appId, apiKey);
            if (cancelled) return;
            setConfigState({ appId, apiKey });
            setIsConnected(true);
          } catch (err) {
            console.warn("Atlas auto-reconnect failed:", err);
          }
        }
      } finally {
        if (!cancelled) setIsRestoring(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setConfig = useCallback(async (c: AtlasConfig) => {
    await SecureStore.setItemAsync(STORAGE_KEY_APP_ID, c.appId);
    await SecureStore.setItemAsync(STORAGE_KEY_API_KEY, c.apiKey);
    setConfigState(c);
    setIsConnected(true);
  }, []);

  const clearConfig = useCallback(async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEY_APP_ID);
    await SecureStore.deleteItemAsync(STORAGE_KEY_API_KEY);
    atlasService.disconnect();
    setConfigState(null);
    setIsConnected(false);
  }, []);

  return (
    <AtlasContext.Provider value={{ config, isConnected, isRestoring, setConfig, clearConfig }}>
      {children}
    </AtlasContext.Provider>
  );
}

export function useAtlas() {
  return useContext(AtlasContext);
}
