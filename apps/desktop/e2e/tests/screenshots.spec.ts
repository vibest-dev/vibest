import path from "node:path";

import { test } from "./fixtures.js";

const screenshotsDir = path.join(import.meta.dirname, "../screenshots");

test.describe("Screenshots", () => {
  test("capture main window on launch", async ({ window }) => {
    // Wait for content to load
    await window.waitForSelector("text=No repositories");

    await window.screenshot({
      path: path.join(screenshotsDir, "01-main-window.png"),
    });
  });

  test("capture repository actions", async ({ window }) => {
    await window.waitForSelector("text=No repositories");

    await window.screenshot({
      path: path.join(screenshotsDir, "02-repository-actions.png"),
    });
  });

  test("capture clone repository dialog", async ({ window }) => {
    await window.getByRole("button", { name: "Clone" }).click();

    // Wait for dialog
    await window.waitForSelector("text=Clone Repository");

    await window.screenshot({
      path: path.join(screenshotsDir, "03-clone-repository-dialog.png"),
    });
  });
});
