import { VibestExtensionMessage } from "@vibest/shared/extension/message";
import { useEffect, useState } from "react";
import { onMessage } from "webext-bridge/sidepanel";

import { Chat } from "@/components/chat";
import { ORPCContextProvider } from "@/context";

export default function SidePanelApp() {
  const [localServerBaseurl, setLocalServerBaseurl] = useState<string | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = onMessage(VibestExtensionMessage.WebAppInit, ({ data }) => {
      setLocalServerBaseurl(data.url);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  if (!localServerBaseurl) {
    return (
      <div className="relative mx-auto size-full h-screen max-w-4xl p-2">
        <div className="flex h-full flex-col items-center justify-center">
          <div className="text-center">
            <h3 className="mb-4 text-xl font-bold text-blue-600">🔍 Waiting for Local Server</h3>
            <div className="space-y-2 text-gray-700">
              <p className="text-base font-medium">
                Please make sure your development server is running
              </p>
              <p className="text-sm text-gray-500">
                If your local server is running, try refreshing the page
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ORPCContextProvider url={localServerBaseurl}>
      <Chat />
    </ORPCContextProvider>
  );
}
