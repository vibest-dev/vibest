import { MessageChannelMain, type MessagePortMain, type WebContents } from "electron";

import { DESKTOP_PORT_CHANNEL } from "../../shared/desktop-channel";

export type AttachMessagePort = (port: MessagePortMain) => () => Promise<void>;

export interface RendererChannel {
  readonly connect: (webContents: WebContents) => () => Promise<void>;
}

export function makeRendererChannel(attachPort: AttachMessagePort): RendererChannel {
  return {
    connect: (webContents) => {
      const { port1, port2 } = new MessageChannelMain();
      const detach = attachPort(port1);
      port1.start();

      try {
        webContents.postMessage(DESKTOP_PORT_CHANNEL, undefined, [port2]);
      } catch (error) {
        void detach();
        port1.close();
        throw error;
      }

      let closed = false;
      return async () => {
        if (closed) return;
        closed = true;
        await detach();
        port1.close();
      };
    },
  };
}
