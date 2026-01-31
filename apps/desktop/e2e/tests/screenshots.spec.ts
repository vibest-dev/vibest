import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, "../screenshots");

test.describe("Screenshots", () => {
	test("capture main window on launch", async ({ window }) => {
		// Wait for content to load
		await window.waitForSelector("text=Repositories");

		await window.screenshot({
			path: path.join(screenshotsDir, "01-main-window.png"),
		});
	});

	test("capture add repository dialog", async ({ window }) => {
		// Open menu
		const plusButton = window.locator(
			'button:has([class*="lucide-plus"]), button:has(svg.lucide-plus)',
		);
		await plusButton.first().click();

		// Click Add Local Repository
		await window.getByText("Add Local Repository").click();

		// Wait for dialog
		await window.waitForSelector("text=Add Repository");

		await window.screenshot({
			path: path.join(screenshotsDir, "02-add-repository-dialog.png"),
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
