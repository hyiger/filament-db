import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * The server connection (base URL + optional API key), persisted in the OS
 * secure store (iOS Keychain / Android Keystore) — never plain storage, since
 * the API key is a credential. Loaded once at app start and exposed app-wide.
 */

const BASE_URL_KEY = 'filamentdb.baseUrl';
const API_KEY_KEY = 'filamentdb.apiKey';

export interface ServerConfig {
  baseUrl: string | null;
  apiKey: string | null;
}

interface ServerConfigContextValue extends ServerConfig {
  loading: boolean;
  save: (cfg: ServerConfig) => Promise<void>;
}

const ServerConfigContext = createContext<ServerConfigContextValue | null>(null);

export function ServerConfigProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [url, key] = await Promise.all([
          SecureStore.getItemAsync(BASE_URL_KEY),
          SecureStore.getItemAsync(API_KEY_KEY),
        ]);
        if (!active) return;
        setBaseUrl(url);
        setApiKey(key);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const save = async (cfg: ServerConfig) => {
    // Normalize: strip trailing slashes off the base URL, treat blanks as unset.
    const url = cfg.baseUrl?.trim().replace(/\/+$/, '') || null;
    // Only persist http(s) addresses — the base URL is concatenated into fetch()
    // and the bearer API key rides every request, so a bad/foreign scheme would
    // either fail obscurely or send the credential somewhere unintended. (GH #693.)
    if (url && !/^https?:\/\/[^/]+/i.test(url)) {
      throw new Error('Enter a full http:// or https:// address, e.g. http://192.168.1.50:3456');
    }
    const key = cfg.apiKey?.trim() || null;
    if (url) await SecureStore.setItemAsync(BASE_URL_KEY, url);
    else await SecureStore.deleteItemAsync(BASE_URL_KEY);
    if (key) await SecureStore.setItemAsync(API_KEY_KEY, key);
    else await SecureStore.deleteItemAsync(API_KEY_KEY);
    setBaseUrl(url);
    setApiKey(key);
  };

  return (
    <ServerConfigContext.Provider value={{ baseUrl, apiKey, loading, save }}>
      {children}
    </ServerConfigContext.Provider>
  );
}

export function useServerConfig(): ServerConfigContextValue {
  const value = useContext(ServerConfigContext);
  if (!value) {
    throw new Error('useServerConfig must be used within a ServerConfigProvider');
  }
  return value;
}
