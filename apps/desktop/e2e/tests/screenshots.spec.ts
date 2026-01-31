import path from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, "../screenshots");

test.describe("Screenshots", () => {
  test("capture main window on launch", async ({ window }) => {
    // Wait for content to load
    await window.waitForSelector("text=Workspace");

    await window.screenshot({
      path: path.join(screenshotsDir, "01-main-window.png"),
    });
  });

  test("capture workspace menu", async ({ window }) => {
    // Open menu
    const plusButton = window.locator(
      'button:has([class*="lucide-plus"]), button:has(svg.lucide-plus)',
    );
    await plusButton.first().click();

    // Wait for menu to show
    await window.waitForSelector("text=Add Local Repository");

    await window.screenshot({
      path: path.join(screenshotsDir, "02-workspace-menu.png"),
    });
  });

  test("capture clone repository dialog", async ({ window }) => {
    // Open menu
    const plusButton = window.locator(
      'button:has([class*="lucide-plus"]), button:has(svg.lucide-plus)',
    );
    await plusButton.first().click();

    // Click Clone from URL
    await window.getByText("Clone from URL").click();

    // Wait for dialog
    await window.waitForSelector("text=Clone Repository");

    await window.screenshot({
      path: path.join(screenshotsDir, "03-clone-repository-dialog.png"),
    });
  });
});
