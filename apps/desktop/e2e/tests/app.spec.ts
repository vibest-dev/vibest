import { expect, test } from "./fixtures.js";

test.describe("App Launch", () => {
  test("should launch and show main window", async ({ window }) => {
    // Verify window is visible
    const isVisible = await window.isVisible("body");
    expect(isVisible).toBe(true);
  });

  test("should display sidebar with Workspace section", async ({ window }) => {
    // Check for Workspace label in sidebar (exact match)
    const workspaceLabel = window.getByText("Workspace", { exact: true });
    await expect(workspaceLabel).toBeVisible();
  });

  test("should show empty state when no repositories", async ({ window }) => {
    // Check for empty state message
    const emptyMessage = window.getByText("No repositories");
    await expect(emptyMessage).toBeVisible({ timeout: 5000 });
  });

  test("should show 'No Worktree Selected' in main content", async ({ window }) => {
    const noWorktreeText = window.getByText("No Worktree Selected");
    await expect(noWorktreeText).toBeVisible();
  });
});

test.describe("Add Repository Menu", () => {
  test("should show add repository menu options", async ({ window }) => {
    // Click the plus button to open menu
    const plusButton = window.locator(
      'button:has([class*="lucide-plus"]), button:has(svg.lucide-plus)',
    );
    await plusButton.first().click();

    // Verify menu items are visible
    const addLocalItem = window.getByText("Add Local Repository");
    const cloneItem = window.getByText("Clone from URL");
    await expect(addLocalItem).toBeVisible();
    await expect(cloneItem).toBeVisible();
  });

  // Note: "Add Local Repository" triggers a native file dialog which cannot be
  // controlled by Playwright. The AddRepositoryDialog only opens after a path
  // is selected from the native dialog. Testing this flow requires mocking
  // the IPC layer or using a different testing approach.
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
