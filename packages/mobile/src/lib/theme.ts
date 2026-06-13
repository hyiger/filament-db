import { useColorScheme } from 'react-native';

/**
 * Minimal light/dark color set. The screens were initially hardcoded for a
 * light background; this makes text/surfaces follow the system color scheme so
 * they're legible in dark mode (the default on most phones) as well as light.
 */
export interface ThemeColors {
  dark: boolean;
  background: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  inputBg: string;
  tint: string;
  onTint: string;
  danger: string;
}

export function useColors(): ThemeColors {
  const dark = useColorScheme() === 'dark';
  return {
    dark,
    background: dark ? '#000000' : '#ffffff',
    card: dark ? '#1c1c1e' : '#f2f2f7',
    text: dark ? '#f2f2f7' : '#11181c',
    muted: dark ? '#9ba1a6' : '#687076',
    border: dark ? '#48484a' : '#d1d1d6',
    inputBg: dark ? '#1c1c1e' : '#ffffff',
    tint: '#208aef',
    onTint: '#ffffff',
    danger: '#ff5a52',
  };
}
