import type { DesktopBridge } from "../shared/bridge";

declare global {
  interface Window {
    vibest: DesktopBridge;
  }
}
