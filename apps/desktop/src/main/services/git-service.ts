import simpleGit, { type SimpleGit } from "simple-git";

import type { Branch, DiffResult, FileDiff, GitStatus } from "../../shared/types";

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

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

  /**
   * Get diff stats (insertions/deletions) for all changes relative to HEAD.
   * This includes both staged and unstaged changes to tracked files.
   * For untracked files, counts all lines as insertions.
   */
  async getDiffStats(path: string): Promise<DiffStats> {
    const git = this.getGit(path);

    // Get stats for tracked files (staged + unstaged) relative to HEAD
    const diffOutput = await git.raw(["diff", "HEAD", "--shortstat"]);

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    // Parse: "12 files changed, 138 insertions(+), 219 deletions(-)"
    if (diffOutput.trim()) {
      const filesMatch = diffOutput.match(/(\d+) files? changed/);
      const insertMatch = diffOutput.match(/(\d+) insertions?\(\+\)/);
      const deleteMatch = diffOutput.match(/(\d+) deletions?\(-\)/);

      filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
      insertions = insertMatch ? parseInt(insertMatch[1], 10) : 0;
      deletions = deleteMatch ? parseInt(deleteMatch[1], 10) : 0;
    }

    // Get untracked files and count their lines
    const status = await git.status();
    for (const file of status.not_added) {
      try {
        const fs = await import("fs/promises");
        const nodePath = await import("path");
        const content = await fs.readFile(nodePath.join(path, file), "utf-8");
        const lines = content.split("\n").length;
        insertions += lines;
        filesChanged += 1;
      } catch {
        // Skip files that can't be read (binary, etc.)
      }
    }

    return { filesChanged, insertions, deletions };
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
}
