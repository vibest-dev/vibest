import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./features/vibest/app";
import { VibestClientRpcProvider } from "./rpc/vibest-client-rpc-context";
import "./index.css";

// biome-ignore lint/style/noNonNullAssertion: exist
const container = document.getElementById("root")!;

createRoot(container).render(
  <StrictMode>
    <VibestClientRpcProvider>
      <App />
    </VibestClientRpcProvider>
  </StrictMode>,
);
