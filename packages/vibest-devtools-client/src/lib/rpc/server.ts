import type { BirpcOptions } from "birpc";

import { RPC_EVENT_NAME } from "./constants";

export interface ServerFunctions {
  connect: () => Promise<boolean>;
}

interface Message {
  event: string;
  data: unknown;
}

export const createServerBirpcOption = <T>() => {
  return {
    post: (data) => {
      window.parent.postMessage(
        {
          event: RPC_EVENT_NAME,
          data,
        } satisfies Message,
        "*",
      );
    },
    on: (handler) => {
      window.addEventListener("message", (event) => {
        const data = event.data satisfies Message;
        if (event.source === window.parent && data.event === RPC_EVENT_NAME) {
          handler(data.data);
        }
      });
    },
    off: (handler) => {
      window.removeEventListener("message", handler);
    },
  } satisfies BirpcOptions<T>;
};
