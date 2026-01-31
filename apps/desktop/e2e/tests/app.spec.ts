import { expect, test } from "./fixtures.js";

test.describe("App Launch", () => {
	test("should launch and show main window", async ({ window }) => {
		// Verify window is visible
		const isVisible = await window.isVisible("body");
		expect(isVisible).toBe(true);
	});

	test("should display sidebar with Repositories section", async ({
		window,
	}) => {
		// Check for Repositories label in sidebar (exact match)
		const reposLabel = window.getByText("Repositories", { exact: true });
		await expect(reposLabel).toBeVisible();
	});

	test("should show empty state when no repositories", async ({ window }) => {
		// Check for empty state message
		const emptyMessage = window.getByText("No repositories");
		await expect(emptyMessage).toBeVisible({ timeout: 5000 });
	});

	test("should show 'No Worktree Selected' in main content", async ({
		window,
	}) => {
		const noWorktreeText = window.getByText("No Worktree Selected");
		await expect(noWorktreeText).toBeVisible();
	});
});

test.describe("Add Repository Dialog", () => {
	test("should open add repository dialog from menu", async ({ window }) => {
		// Click the plus button to open menu
		const plusButton = window.locator(
			'button:has([class*="lucide-plus"]), button:has(svg.lucide-plus)',
		);
		await plusButton.first().click();

		// Click "Add Local Repository" menu item
		const addLocalItem = window.getByText("Add Local Repository");
		await expect(addLocalItem).toBeVisible();
		await addLocalItem.click();

		// Verify dialog opens (use heading role to be specific)
		const dialogTitle = window.getByRole("heading", { name: "Add Repository" });
		await expect(dialogTitle).toBeVisible();
	});

	test("should close dialog when clicking Cancel", async ({ window }) => {
		// Open dialog
		const plusButton = window.locator(
			'button:has([class*="lucide-plus"]), button:has(svg.lucide-plus)',
		);
		await plusButton.first().click();
		await window.getByText("Add Local Repository").click();

		// Wait for dialog to open
		const dialogTitle = window.getByRole("heading", { name: "Add Repository" });
		await expect(dialogTitle).toBeVisible();

		// Click Cancel
		const cancelButton = window.getByRole("button", { name: "Cancel" });
		await cancelButton.click();

		// Verify dialog is closed
		await expect(dialogTitle).not.toBeVisible();
	});

	test("should show error when submitting empty path", async ({ window }) => {
		// Open dialog
		const plusButton = window.locator(
			'button:has([class*="lucide-plus"]), button:has(svg.lucide-plus)',
		);
		await plusButton.first().click();
		await window.getByText("Add Local Repository").click();

		// Click Add Repository without entering path
		const addButton = window.getByRole("button", { name: "Add Repository" });
		await addButton.click();

		// Verify error message
		const errorMessage = window.getByText("Select a directory");
		await expect(errorMessage).toBeVisible();
	});
});

test.describe("Clone Repository Dialog", () => {
	test("should open clone repository dialog from menu", async ({ window }) => {
		// Click the plus button to open menu
		const plusButton = window.locator(
			'button:has([class*="lucide-plus"]), button:has(svg.lucide-plus)',
		);
		await plusButton.first().click();

		// Click "Clone from URL" menu item
		const cloneItem = window.getByText("Clone from URL");
		await expect(cloneItem).toBeVisible();
		await cloneItem.click();

		// Verify dialog opens (use heading role to be specific)
		const dialogTitle = window.getByRole("heading", {
			name: "Clone Repository",
		});
		await expect(dialogTitle).toBeVisible();
	});
});
