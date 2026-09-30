/**
 * In-memory stand-in for `@react-native-async-storage/async-storage` (a React
 * Native native module that can't load under Node). vitest.config.ts aliases
 * the package here so tests can exercise packages/mobile's write queue.
 */
const store = new Map<string, string>();

const AsyncStorage = {
  getItem: async (key: string): Promise<string | null> => store.get(key) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    store.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    store.delete(key);
  },
};

export function resetAsyncStorage(): void {
  store.clear();
}

export default AsyncStorage;
