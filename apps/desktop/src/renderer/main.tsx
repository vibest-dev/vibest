import { createApp } from "@vibest/app/app";
import { createRoot } from "react-dom/client";

import "@vibest/app/index.css";

import { createDesktopClient } from "./desktop-client";
import { createDesktopPlatform } from "./desktop-platform";
import { waitForDesktopPort } from "./desktop-port";

const rootElement = document.getElementById("root")!;
if (!rootElement) throw new Error("Root element not found");

function showStartupFailure(error: unknown): void {
  const container = document.createElement("main");
  container.style.cssText =
    "min-height:100vh;display:grid;place-items:center;padding:32px;font-family:system-ui,sans-serif";

  const content = document.createElement("div");
  content.style.cssText = "max-width:520px;text-align:center";

  const title = document.createElement("h1");
  title.textContent = "Vibest could not start";
  title.style.cssText = "font-size:20px;margin:0 0 8px";

  const message = document.createElement("p");
  message.textContent =
    error instanceof Error
      ? error.message
      : "The desktop shell did not provide a valid connection.";
  message.style.cssText = "font-size:14px;line-height:1.5;color:#737373;margin:0";

  content.append(title, message);
  container.append(content);
  rootElement.replaceChildren(container);
}

async function bootstrap(): Promise<void> {
  const port = await waitForDesktopPort();
  const client = createDesktopClient(port);
  const desktop = await client.bootstrap();
  const platform = createDesktopPlatform(client, desktop);
  createRoot(rootElement).render(createApp(platform));
}

void bootstrap().catch(showStartupFailure);
