import type { InspectedTargetData } from "@vibest/code-inspector-web";
import type { VibestExtensionMessage } from "@vibest/shared/extension/message";
import type { ProtocolWithReturn } from "webext-bridge";

declare module "webext-bridge" {
  export interface ProtocolMap {
    [VibestExtensionMessage.WebAppInit]: ProtocolWithReturn<{ url: string }, void>;
    [VibestExtensionMessage.Inspected]: ProtocolWithReturn<
      { targets: InspectedTargetData[] },
      void
    >;
  }
}
