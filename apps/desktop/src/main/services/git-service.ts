import simpleGit, { type SimpleGit } from "simple-git";

import type {
  Branch,
  DiffFileInfo,
  DiffResult,
  DiffStats,
  FileDiff,
  FileDiffContent,
  GitStatus,
} from "../../shared/types";

export class GitService {
  private getGit(path: string): SimpleGit {
    return simpleGit(path);
  }

  async isGitRepository(path: string): Promise<boolean> {
    try {
      const git = this.getGit(path);
      return await git.checkIsRepo();
    } catch {
      return false;
    }
  }

  async clone(url: string, targetPath: string): Promise<void> {
    const git = simpleGit();
    await git.clone(url, targetPath);
  }

  async getRemoteUrl(path: string): Promise<string> {
    try {
      const git = this.getGit(path);
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      return origin?.refs?.fetch || "";
    } catch {
      return "";
    }
  }

  async getStatus(path: string): Promise<GitStatus> {
    const git = this.getGit(path);
    const status = await git.status();

    return {
      branch: status.current || "",
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged.length,
      modified: status.modified.length + status.renamed.length + status.deleted.length,
      untracked: status.not_added.length,
      clean: status.isClean(),
    };
  }

  async fetch(path: string): Promise<void> {
    const git = this.getGit(path);
    await git.fetch(["--all", "--prune"]);
  }

  async pull(path: string): Promise<void> {
    const git = this.getGit(path);
    await git.pull();
  }

  async getBranches(path: string): Promise<Branch[]> {
    const git = this.getGit(path);
    const branchSummary = await git.branch(["-a", "-v"]);

    const branches: Branch[] = [];
    const seen = new Set<string>();

    // First add local branches
    for (const [name, data] of Object.entries(branchSummary.branches)) {
      if (name.startsWith("remotes/")) {
        continue;
      }

      if (!seen.has(name)) {
        seen.add(name);

        let remote = "";
        const remoteName = `remotes/origin/${name}`;
        if (branchSummary.branches[remoteName]) {
          remote = `origin/${name}`;
        }

        branches.push({
          name,
          current: data.current,
          remote,
        });
      }
    }

    // Then add remote-only branches (not checked out locally)
    for (const name of Object.keys(branchSummary.branches)) {
      if (!name.startsWith("remotes/origin/")) {
        continue;
      }

      // Extract branch name: remotes/origin/main -> main
      const branchName = name.replace("remotes/origin/", "");

      // Skip HEAD reference
      if (branchName === "HEAD") {
        continue;
      }

      // Skip if already added as local branch
      if (seen.has(branchName)) {
        continue;
      }

      seen.add(branchName);
      branches.push({
        name: branchName,
        current: false,
        remote: `origin/${branchName}`,
      });
    }

    return branches;
  }

  async getCurrentBranch(path: string): Promise<string> {
    const git = this.getGit(path);
    const status = await git.status();
    return status.current || "";
  }

  async getDefaultBranch(path: string): Promise<string> {
    const git = this.getGit(path);

    // 1. Try to get remote HEAD reference (most reliable)
    try {
      const remoteHead = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      // Format: refs/remotes/origin/main -> main
      const match = remoteHead.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // No remote HEAD set, continue to fallback
    }

    // 2. Check local branches for main/master
    const branches = await git.branch(["-a"]);

    if (branches.all.includes("main")) return "main";
    if (branches.all.includes("master")) return "master";

    // 3. Check remote branches
    if (branches.all.some((b) => b.includes("origin/main"))) return "main";
    if (branches.all.some((b) => b.includes("origin/master"))) return "master";

    // 4. Fallback to current branch
    return branches.current || "main";
  }

  async getGitUserName(path: string): Promise<string> {
    try {
      const git = this.getGit(path);
      const name = await git.raw(["config", "user.name"]);
      return name.trim() || "user";
    } catch {
      return "user";
    }
  }

  async commitAll(path: string, message: string): Promise<void> {
    const git = this.getGit(path);
    await git.add("-A");
    await git.commit(message);
  }

  async deleteBranch(repositoryPath: string, branchName: string): Promise<void> {
    const git = this.getGit(repositoryPath);
    await git.raw(["branch", "-D", branchName]);
  }

  async getDiff(path: string, staged = false): Promise<DiffResult> {
    const git = this.getGit(path);
    const status = await git.status();

    const files: FileDiff[] = [];
    let insertions = 0;
    let deletions = 0;

    // Determine which files to process based on staged flag
    const filesToProcess: Array<{ file: string; status: FileDiff["status"] }> = [];

    if (staged) {
      // Only staged files
      for (const file of status.staged) {
        filesToProcess.push({ file, status: "modified" });
      }
      for (const file of status.created) {
        if (status.staged.includes(file)) {
          filesToProcess.push({ file, status: "added" });
        }
      }
      for (const file of status.deleted) {
        if (status.staged.includes(file)) {
          filesToProcess.push({ file, status: "deleted" });
        }
      }
      for (const file of status.renamed) {
        filesToProcess.push({ file: file.to, status: "renamed" });
      }
    } else {
      // All changes (staged + unstaged)
      const allFiles = new Set<string>();

      // Modified files
      for (const file of status.modified) {
        allFiles.add(file);
      }

      // Staged files
      for (const file of status.staged) {
        allFiles.add(file);
      }

      // Created/new files
      for (const file of status.created) {
        allFiles.add(file);
      }

      // Not added (untracked)
      for (const file of status.not_added) {
        allFiles.add(file);
      }

      // Deleted files
      for (const file of status.deleted) {
        allFiles.add(file);
      }

      // Renamed files
      for (const file of status.renamed) {
        allFiles.add(file.to);
      }

      // Determine status for each file
      for (const file of allFiles) {
        let fileStatus: FileDiff["status"] = "modified";

        if (status.created.includes(file) || status.not_added.includes(file)) {
          fileStatus = "added";
        } else if (status.deleted.includes(file)) {
          fileStatus = "deleted";
        } else if (status.renamed.some((r) => r.to === file)) {
          fileStatus = "renamed";
        }

        filesToProcess.push({ file, status: fileStatus });
      }
    }

    // Process each file
    for (const { file, status: fileStatus } of filesToProcess) {
      try {
        let oldContents: string | null = null;
        let newContents: string | null = null;

        if (fileStatus === "added") {
          // New file - no old content
          oldContents = null;
          try {
            if (staged) {
              // Get from index
              newContents = await git.show([`:${file}`]);
            } else {
              // Get from working directory
              const fs = await import("fs/promises");
              const nodePath = await import("path");
              newContents = await fs.readFile(nodePath.join(path, file), "utf-8");
            }
          } catch {
            newContents = "";
          }
        } else if (fileStatus === "deleted") {
          // Deleted file - no new content
          try {
            oldContents = await git.show([`HEAD:${file}`]);
          } catch {
            oldContents = "";
          }
          newContents = null;
        } else {
          // Modified or renamed - get both versions
          try {
            oldContents = await git.show([`HEAD:${file}`]);
          } catch {
            // File might not exist in HEAD (could be a newly tracked file)
            oldContents = "";
          }

          try {
            if (staged) {
              // Get staged version from index
              newContents = await git.show([`:${file}`]);
            } else {
              // Get working directory version
              const fs = await import("fs/promises");
              const nodePath = await import("path");
              newContents = await fs.readFile(nodePath.join(path, file), "utf-8");
            }
          } catch {
            newContents = "";
          }
        }

        // Count rough insertions/deletions
        const oldLines = oldContents?.split("\n").length ?? 0;
        const newLines = newContents?.split("\n").length ?? 0;
        if (newLines > oldLines) {
          insertions += newLines - oldLines;
        } else {
          deletions += oldLines - newLines;
        }

        files.push({
          oldFile: oldContents !== null ? { filename: file, contents: oldContents } : null,
          newFile: newContents !== null ? { filename: file, contents: newContents } : null,
          status: fileStatus,
        });
      } catch {
        // Skip files that can't be read (binary files, etc.)
      }
    }

    return {
      files,
      stats: {
        filesChanged: files.length,
        insertions,
        deletions,
      },
    };
  }

  /**
   * Get lightweight diff stats without file content.
   * Uses git diff --numstat for accurate line counts.
   */
  async getDiffStats(path: string): Promise<DiffStats> {
    const git = this.getGit(path);
    const fs = await import("fs/promises");
    const nodePath = await import("path");

    // Get status to determine file states
    const status = await git.status();

    // Get numstat for accurate insertions/deletions
    const [stagedNumstat, unstagedNumstat] = await Promise.all([
      git.diff(["--cached", "--numstat"]).catch(() => ""),
      git.diff(["--numstat"]).catch(() => ""),
    ]);

    // Parse numstat output: "insertions\tdeletions\tfilename"
    const parseNumstat = (output: string): Map<string, { insertions: number; deletions: number }> => {
      const map = new Map();
      for (const line of output.split("\n").filter(Boolean)) {
        const [ins, del, file] = line.split("\t");
        if (file) {
          map.set(file, {
            insertions: ins === "-" ? 0 : Number.parseInt(ins, 10) || 0,
            deletions: del === "-" ? 0 : Number.parseInt(del, 10) || 0,
          });
        }
      }
      return map;
    };

    const stagedStats = parseNumstat(stagedNumstat);
    const unstagedStats = parseNumstat(unstagedNumstat);

    const files: DiffFileInfo[] = [];
    let totalInsertions = 0;
    let totalDeletions = 0;

    // Helper to get file size
    const getFileSize = async (filePath: string): Promise<number> => {
      try {
        const stat = await fs.stat(nodePath.join(path, filePath));
        return stat.size;
      } catch {
        return 0;
      }
    };

    // Track processed files to avoid duplicates
    const processedFiles = new Set<string>();

    // Process created files (staged new files)
    for (const file of status.created) {
      processedFiles.add(file);
      const stats = stagedStats.get(file) ?? { insertions: 0, deletions: 0 };
      const size = await getFileSize(file);
      files.push({
        path: file,
        status: "added",
        staged: true,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size,
      });
      totalInsertions += stats.insertions;
      totalDeletions += stats.deletions;
    }

    // Process staged files (modified files that are staged)
    for (const file of status.staged) {
      if (processedFiles.has(file)) continue; // Skip created files already processed
      processedFiles.add(file);
      const stats = stagedStats.get(file) ?? { insertions: 0, deletions: 0 };
      const size = await getFileSize(file);
      files.push({
        path: file,
        status: "modified",
        staged: true,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size,
      });
      totalInsertions += stats.insertions;
      totalDeletions += stats.deletions;
    }

    // Process modified files (unstaged)
    for (const file of status.modified) {
      if (processedFiles.has(file)) continue; // Already processed
      processedFiles.add(file);
      const stats = unstagedStats.get(file) ?? { insertions: 0, deletions: 0 };
      const size = await getFileSize(file);
      files.push({
        path: file,
        status: "modified",
        staged: false,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size,
      });
      totalInsertions += stats.insertions;
      totalDeletions += stats.deletions;
    }

    // Process untracked files
    for (const file of status.not_added) {
      if (processedFiles.has(file)) continue; // Already processed
      processedFiles.add(file);
      const size = await getFileSize(file);
      // Count lines for new files
      let insertions = 0;
      try {
        const content = await fs.readFile(nodePath.join(path, file), "utf-8");
        insertions = content.split("\n").length;
      } catch {
        // Binary or unreadable
      }
      files.push({
        path: file,
        status: "added",
        staged: false,
        insertions,
        deletions: 0,
        size,
      });
      totalInsertions += insertions;
    }

    // Process deleted files
    for (const file of status.deleted) {
      if (processedFiles.has(file)) continue; // Already processed
      processedFiles.add(file);
      const isStaged = status.staged.includes(file);
      const stats = (isStaged ? stagedStats : unstagedStats).get(file) ?? { insertions: 0, deletions: 0 };
      files.push({
        path: file,
        status: "deleted",
        staged: isStaged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size: 0,
      });
      totalInsertions += stats.insertions;
      totalDeletions += stats.deletions;
    }

    // Process renamed files
    for (const renamed of status.renamed) {
      if (processedFiles.has(renamed.to)) continue; // Already processed
      processedFiles.add(renamed.to);
      const isStaged = status.staged.includes(renamed.to);
      const stats = (isStaged ? stagedStats : unstagedStats).get(renamed.to) ?? { insertions: 0, deletions: 0 };
      const size = await getFileSize(renamed.to);
      files.push({
        path: renamed.to,
        status: "renamed",
        staged: isStaged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size,
      });
      totalInsertions += stats.insertions;
      totalDeletions += stats.deletions;
    }

    return {
      files,
      totalInsertions,
      totalDeletions,
    };
  }

  /**
   * Get single file diff content. Returns error for files > 1MB.
   */
  async getFileDiff(
    repoPath: string,
    filePath: string,
    staged = false,
  ): Promise<FileDiffContent> {
    const git = this.getGit(repoPath);
    const fs = await import("fs/promises");
    const nodePath = await import("path");

    const MAX_SIZE = 1024 * 1024; // 1MB

    // Check file size
    try {
      const fullPath = nodePath.join(repoPath, filePath);
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_SIZE) {
        return {
          path: filePath,
          oldContent: null,
          newContent: null,
          error: "too_large",
        };
      }
    } catch {
      // File might be deleted, continue
    }

    try {
      let oldContent: string | null = null;
      let newContent: string | null = null;

      // Get old content from HEAD
      try {
        oldContent = await git.show([`HEAD:${filePath}`]);
      } catch {
        // File doesn't exist in HEAD (new file)
        oldContent = null;
      }

      // Get new content
      try {
        if (staged) {
          newContent = await git.show([`:${filePath}`]);
        } else {
          const fullPath = nodePath.join(repoPath, filePath);
          newContent = await fs.readFile(fullPath, "utf-8");
        }
      } catch {
        // File might be deleted
        newContent = null;
      }

      // Check if binary (contains null bytes)
      const isBinary = (content: string | null) =>
        content !== null && content.includes("\0");

      if (isBinary(oldContent) || isBinary(newContent)) {
        return {
          path: filePath,
          oldContent: null,
          newContent: null,
          error: "binary",
        };
      }

      return {
        path: filePath,
        oldContent,
        newContent,
      };
    } catch {
      return {
        path: filePath,
        oldContent: null,
        newContent: null,
        error: "not_found",
      };
    }
  }
}
