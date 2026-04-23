import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useColorScheme as useSystemColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Colors } from "../theme/colors";

type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  theme: ResolvedTheme;
  colors: typeof Colors.light;
}

const STORAGE_KEY = "filamentdb-theme";

const ThemeContext = createContext<ThemeContextValue>({
  mode: "system",
  setMode: () => {},
  theme: "light",
  colors: Colors.light,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useSystemColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === "light" || stored === "dark" || stored === "system") {
        setModeState(stored);
      }
    });
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    AsyncStorage.setItem(STORAGE_KEY, m);
  }, []);

  const theme: ResolvedTheme = mode === "system" ? (systemScheme ?? "light") : mode;
  const colors = Colors[theme];

  return (
    <ThemeContext.Provider value={{ mode, setMode, theme, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
