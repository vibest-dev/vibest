import { DESKTOP_PORT_CHANNEL } from "../shared/desktop-channel";

const PORT_TIMEOUT_MS = 15_000;

/**
 * The preload installs its IPC relay before page scripts run, but Main only
 * transfers the port after `did-finish-load`. The renderer must therefore wait
 * for the relayed window message even though the preload is already active.
 */
export function waitForDesktopPort(): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      if (event.data?.type !== DESKTOP_PORT_CHANNEL) return;
      const [port] = event.ports;
      if (!port) return;

      window.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      port.start();
      resolve(port);
    };
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("The desktop RPC channel did not become available."));
    }, PORT_TIMEOUT_MS);

    window.addEventListener("message", onMessage);
  });
}
