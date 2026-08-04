/** The OS a native host runs on. `undefined` means the browser. */
export type PlatformOs = "macos" | "windows" | "linux";

/** Browser or native capabilities supplied by the host entry point. */
export type Platform = {
  /** Close the host application when that operation exists. */
  quit?: () => void;
  /**
   * The desktop host's OS, left unset by the browser entry point. macOS draws
   * native traffic lights over the shell's top-left corner; everywhere else
   * that corner is ours to fill — see `routes/__root.tsx`.
   */
  os?: PlatformOs;
};
