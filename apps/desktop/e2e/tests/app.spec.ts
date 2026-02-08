import { expect, test } from "./fixtures.js";

test.describe("App Launch", () => {
  test("should launch and show main window", async ({ window }) => {
    // Verify window is visible
    const isVisible = await window.isVisible("body");
    expect(isVisible).toBe(true);
  });

  test("should display top-level empty workspace state", async ({ window }) => {
    const emptyMessage = window.getByText("No repositories");
    await expect(emptyMessage).toBeVisible();
  });

  test("should show repository actions when no repositories", async ({ window }) => {
    await expect(window.getByRole("button", { name: "Add" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Clone" })).toBeVisible();
  });

  test("should show 'No Worktree Selected' in main content", async ({ window }) => {
    const noWorktreeText = window.getByText("No worktree selected");
    await expect(noWorktreeText).toBeVisible();
  });
});

test.describe("Repository Actions", () => {
  test("should show add and clone actions in empty state", async ({ window }) => {
    await expect(window.getByRole("button", { name: "Add" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Clone" })).toBeVisible();
  });
});

test.describe("Clone Repository Dialog", () => {
  test("should open clone repository dialog from empty state", async ({ window }) => {
    await window.getByRole("button", { name: "Clone" }).click();

    // Verify dialog opens (use heading role to be specific)
    const dialogTitle = window.getByRole("heading", {
      name: "Clone Repository",
    });
    await expect(dialogTitle).toBeVisible();
  });
});
