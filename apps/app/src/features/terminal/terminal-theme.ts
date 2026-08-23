import type { ITheme } from "@xterm/xterm";

/** Resolve theme tokens to computed colors so xterm is not given `var(--*)` strings. */
export function readTerminalTheme(root: HTMLElement = document.documentElement): ITheme {
  const probe = document.createElement("div");
  probe.style.color = "var(--foreground)";
  probe.style.backgroundColor = "var(--background)";
  root.append(probe);
  const styles = getComputedStyle(probe);
  const theme: ITheme = {
    foreground: styles.color,
    background: styles.backgroundColor,
    cursor: styles.color,
    cursorAccent: styles.backgroundColor,
  };
  probe.remove();
  return theme;
}
