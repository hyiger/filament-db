// Root CI installs only the root package, so `tsc` can't resolve this import
// when it follows a test into packages/mobile/src/lib/writeQueue.ts. At run
// time vitest.config.ts aliases the package to tests/stubs/asyncStorage.ts.
declare module "@react-native-async-storage/async-storage" {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  export default AsyncStorage;
}
