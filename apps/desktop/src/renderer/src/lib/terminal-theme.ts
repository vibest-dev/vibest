import type { ITheme } from "@xterm/xterm";

export interface TerminalTheme {
  id: string;
  name: string;
  dark: ITheme;
  light: ITheme;
}

export const terminalThemes: TerminalTheme[] = [
  {
    id: "cursor",
    name: "Cursor",
    // Extracted from Cursor editor theme-cursor extension
    dark: {
      background: "#141414",
      foreground: "#E4E4E4",
      cursor: "#E4E4E4",
      cursorAccent: "#141414",
      selectionBackground: "rgba(228, 228, 228, 0.12)",
      black: "#242424",
      red: "#FC6B83",
      green: "#3FA266",
      yellow: "#D2943E",
      blue: "#81A1C1",
      magenta: "#B48EAD",
      cyan: "#88C0D0",
      white: "#E4E4E4",
      brightBlack: "#5C6370",
      brightRed: "#FC6B83",
      brightGreen: "#70B489",
      brightYellow: "#F1B467",
      brightBlue: "#87A6C4",
      brightMagenta: "#B48EAD",
      brightCyan: "#88C0D0",
      brightWhite: "#FFFFFF",
    },
    light: {
      background: "#F3F3F3",
      foreground: "#141414",
      cursor: "#141414",
      cursorAccent: "#F3F3F3",
      selectionBackground: "rgba(20, 20, 20, 0.12)",
      black: "#141414",
      red: "#CF2D56",
      green: "#1F8A65",
      yellow: "#A16900",
      blue: "#3C7CAB",
      magenta: "#B8448B",
      cyan: "#4C7F8C",
      white: "#FCFCFC",
      brightBlack: "#6B6B6B",
      brightRed: "#E75E78",
      brightGreen: "#55A583",
      brightYellow: "#C08532",
      brightBlue: "#6299C3",
      brightMagenta: "#D06BA6",
      brightCyan: "#6F9BA6",
      brightWhite: "#FFFFFF",
    },
  },
  {
    id: "nord",
    name: "Nord",
    // https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/schemes/Cursor%20Dark.itermcolors
    dark: {
      background: "#141414",
      foreground: "#ffffff",
      cursor: "#ffffff",
      cursorAccent: "#141414",
      selectionBackground: "#303030",
      black: "#2a2a2a",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#d8dee9",
      brightBlack: "#505050",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#88c0d0",
      brightWhite: "#ffffff",
    },
    // https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/schemes/Atom%20One%20Light.itermcolors
    light: {
      background: "#f9f9f9",
      foreground: "#2a2c33",
      cursor: "#bbbbbb",
      cursorAccent: "#ffffff",
      selectionBackground: "#ededed",
      black: "#000000",
      red: "#de3e35",
      green: "#3f953a",
      yellow: "#d2b67c",
      blue: "#2f5af3",
      magenta: "#950095",
      cyan: "#3f953a",
      white: "#bbbbbb",
      brightBlack: "#000000",
      brightRed: "#de3e35",
      brightGreen: "#3f953a",
      brightYellow: "#d2b67c",
      brightBlue: "#2f5af3",
      brightMagenta: "#a00095",
      brightCyan: "#3f953a",
      brightWhite: "#ffffff",
    },
  },
];

export function getTerminalTheme(themeId: string, isDark: boolean): ITheme {
  const theme = terminalThemes.find((t) => t.id === themeId) ?? terminalThemes[0];
  return isDark ? theme.dark : theme.light;
}

// Legacy exports for backward compatibility
export const TERMINAL_THEME_DARK = terminalThemes[0].dark;
export const TERMINAL_THEME_LIGHT = terminalThemes[0].light;
