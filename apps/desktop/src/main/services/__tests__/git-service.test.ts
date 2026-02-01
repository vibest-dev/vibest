import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitService } from "../git-service";

describe("GitService.getDiffStats", () => {
  let tmpDir: string;
  let gitService: GitService;

  beforeEach(async () => {
    // Create temp directory
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-test-"));
    gitService = new GitService();

    // Initialize git repo
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig("user.email", "test@test.com");
    await git.addConfig("user.name", "Test User");

    // Create initial commit
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\n");
    await git.add(".");
    await git.commit("Initial commit");
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return empty for clean repo", async () => {
    const stats = await gitService.getDiffStats(tmpDir);

    expect(stats.files).toEqual([]);
    expect(stats.totalInsertions).toBe(0);
    expect(stats.totalDeletions).toBe(0);
  });

  it("should count insertions for new lines in tracked file", async () => {
    // Modify tracked file - add 3 lines
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\nLine 1\nLine 2\nLine 3\n");

    const stats = await gitService.getDiffStats(tmpDir);

    expect(stats.files.length).toBe(1);
    expect(stats.totalInsertions).toBe(3);
    expect(stats.totalDeletions).toBe(0);
  });

  it("should count deletions for removed lines", async () => {
    // Add more content first
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\nLine 1\nLine 2\nLine 3\n");
    const git = simpleGit(tmpDir);
    await git.add(".");
    await git.commit("Add lines");

    // Now delete lines
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\n");

    const stats = await gitService.getDiffStats(tmpDir);

    expect(stats.files.length).toBe(1);
    expect(stats.totalInsertions).toBe(0);
    expect(stats.totalDeletions).toBe(3);
  });

  it("should count both insertions and deletions", async () => {
    // Modify file - replace content
    await fs.writeFile(path.join(tmpDir, "README.md"), "# New Title\nNew content\n");

    const stats = await gitService.getDiffStats(tmpDir);

    expect(stats.files.length).toBe(1);
    expect(stats.totalInsertions).toBeGreaterThan(0);
    expect(stats.totalDeletions).toBeGreaterThan(0);
  });

  it("should include staged changes", async () => {
    // Add new file and stage it
    await fs.writeFile(path.join(tmpDir, "new-file.txt"), "Line 1\nLine 2\n");
    const git = simpleGit(tmpDir);
    await git.add("new-file.txt");

    const stats = await gitService.getDiffStats(tmpDir);

    expect(stats.files.length).toBe(1);
    expect(stats.files[0].staged).toBe(true);
    expect(stats.totalInsertions).toBe(2);
  });

  it("should include both staged and unstaged changes", async () => {
    const git = simpleGit(tmpDir);

    // Stage a new file
    await fs.writeFile(path.join(tmpDir, "staged.txt"), "Staged\n");
    await git.add("staged.txt");

    // Modify tracked file without staging
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\nUnstaged change\n");

    const stats = await gitService.getDiffStats(tmpDir);

    expect(stats.files.length).toBe(2);
    expect(stats.totalInsertions).toBeGreaterThanOrEqual(2);
  });

  it("should include untracked files", async () => {
    // Create untracked file with 5 lines
    await fs.writeFile(
      path.join(tmpDir, "untracked.txt"),
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n",
    );

    const stats = await gitService.getDiffStats(tmpDir);

    expect(stats.files.length).toBe(1);
    expect(stats.files[0].staged).toBe(false);
    expect(stats.totalInsertions).toBe(6); // 5 lines + trailing newline = 6 when split
  });

  it("should handle multiple files", async () => {
    // Create multiple changes
    await fs.writeFile(path.join(tmpDir, "file1.txt"), "Content 1\n");
    await fs.writeFile(path.join(tmpDir, "file2.txt"), "Content 2\n");
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Modified\n");

    const stats = await gitService.getDiffStats(tmpDir);

    expect(stats.files.length).toBe(3);
  });
});
