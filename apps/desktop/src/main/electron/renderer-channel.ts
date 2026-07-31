import { Context, Effect } from "effect";
import { MessageChannelMain, type MessagePortMain } from "electron";

import { DESKTOP_PORT_CHANNEL } from "../../shared/desktop-channel";
import type { ConnectRenderer } from "./renderer-lifecycle";

export type AttachMessagePort = (port: MessagePortMain) => () => Promise<void>;

export class RendererChannel extends Context.Service<
  RendererChannel,
  {
    readonly connect: ConnectRenderer;
  }
>()("desktop/RendererChannel") {}

// Establishing a peer is a scoped acquisition: the release awaits the oRPC
// detach promise before closing the port, so closing the Scope observes the
// peer's full cleanup instead of firing it off untracked.
export function makeRendererChannel(attachPort: AttachMessagePort): RendererChannel["Service"] {
  return {
    connect: (webContents) =>
      Effect.gen(function* () {
        const peer = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const { port1, port2 } = new MessageChannelMain();
            const detach = attachPort(port1);
            port1.start();
            return { port1, port2, detach };
          }),
          (acquired) =>
            Effect.promise(() => acquired.detach()).pipe(
              Effect.ensuring(Effect.sync(() => acquired.port1.close())),
            ),
        );
        // A failed handoff (e.g. destroyed webContents) fails the surrounding
        // Scope, which runs the release above.
        yield* Effect.try(() =>
          webContents.postMessage(DESKTOP_PORT_CHANNEL, undefined, [peer.port2]),
        );
      }),
  };
}
