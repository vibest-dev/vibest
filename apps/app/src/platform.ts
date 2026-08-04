/** Browser or native capabilities supplied by the host entry point. */
export type Platform = {
  /** Close the host application when that operation exists. */
  quit?: () => void;
  /**
   * True when the host window draws native traffic-light controls over the
   * shell's top-left corner (desktop only). The browser has none, so that
   * corner renders a brand mark there instead — see `routes/__root.tsx`.
   */
  hasWindowControls?: boolean;
};
