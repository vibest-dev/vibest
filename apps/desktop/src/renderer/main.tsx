import { createApp } from "@vibest/app/app";
import type { Platform } from "@vibest/app/platform";
import { createRoot } from "react-dom/client";

import "@vibest/app/index.css";

const bridge = window.vibest;

if (!bridge) {
  throw new Error("Preload bridge missing — the renderer cannot reach its backend");
}

const platform: Platform = {
  host: "desktop",
  os: bridge.os,
  backend: bridge.backend,
};

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(createApp(platform));
