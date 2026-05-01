import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import * as SecureStore from "expo-secure-store";

interface AtlasConfig {
  appId: string;
  apiKey: string;
}

interface AtlasContextValue {
  config: AtlasConfig | null;
  isConnected: boolean;
  setConfig: (config: AtlasConfig) => Promise<void>;
  clearConfig: () => Promise<void>;
}

const STORAGE_KEY_APP_ID = "filamentdb-atlas-app-id";
const STORAGE_KEY_API_KEY = "filamentdb-atlas-api-key";

const AtlasContext = createContext<AtlasContextValue>({
  config: null,
  isConnected: false,
  setConfig: async () => {},
  clearConfig: async () => {},
});

export function AtlasProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<AtlasConfig | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const setConfig = useCallback(async (c: AtlasConfig) => {
    await SecureStore.setItemAsync(STORAGE_KEY_APP_ID, c.appId);
    await SecureStore.setItemAsync(STORAGE_KEY_API_KEY, c.apiKey);
    setConfigState(c);
    setIsConnected(true);
  }, []);

  const clearConfig = useCallback(async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEY_APP_ID);
    await SecureStore.deleteItemAsync(STORAGE_KEY_API_KEY);
    setConfigState(null);
    setIsConnected(false);
  }, []);

  return (
    <AtlasContext.Provider value={{ config, isConnected, setConfig, clearConfig }}>
      {children}
    </AtlasContext.Provider>
  );
}

export function useAtlas() {
  return useContext(AtlasContext);
}
