import fs from "node:fs/promises";
import nodePath from "node:path";

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

    // Set lookups instead of repeated Array.includes/some scans below
    const stagedFiles = new Set(status.staged);
    const createdFiles = new Set(status.created);
    const untrackedFiles = new Set(status.not_added);
    const deletedFiles = new Set(status.deleted);
    const renamedTargets = new Set(status.renamed.map((r) => r.to));

    // Determine which files to process based on staged flag
    const filesToProcess: Array<{ file: string; status: FileDiff["status"] }> = [];

    if (staged) {
      // Only staged files
      for (const file of status.staged) {
        filesToProcess.push({ file, status: "modified" });
      }
      for (const file of status.created) {
        if (stagedFiles.has(file)) {
          filesToProcess.push({ file, status: "added" });
        }
      }
      for (const file of status.deleted) {
        if (stagedFiles.has(file)) {
          filesToProcess.push({ file, status: "deleted" });
        }
      }
      for (const file of status.renamed) {
        filesToProcess.push({ file: file.to, status: "renamed" });
      }
    } else {
      // All changes (staged + unstaged), in insertion order
      const allFiles = new Set<string>([
        ...status.modified,
        ...status.staged,
        ...status.created,
        ...status.not_added,
        ...status.deleted,
        ...renamedTargets,
      ]);

      // Determine status for each file
      for (const file of allFiles) {
        let fileStatus: FileDiff["status"] = "modified";

        if (createdFiles.has(file) || untrackedFiles.has(file)) {
          fileStatus = "added";
        } else if (deletedFiles.has(file)) {
          fileStatus = "deleted";
        } else if (renamedTargets.has(file)) {
          fileStatus = "renamed";
        }

        filesToProcess.push({ file, status: fileStatus });
      }
    }

    // Read every file in parallel; these are read-only lookups (git show / fs.readFile),
    // so they cannot race with each other. Promise.all keeps the original order.
    const results = await Promise.all(
      filesToProcess.map(async ({ file, status: fileStatus }): Promise<FileDiff | null> => {
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
                newContents = await fs.readFile(nodePath.join(path, file), "utf-8");
              }
            } catch {
              newContents = "";
            }
          }

          return {
            oldFile: oldContents !== null ? { filename: file, contents: oldContents } : null,
            newFile: newContents !== null ? { filename: file, contents: newContents } : null,
            status: fileStatus,
          };
        } catch {
          // Skip files that can't be read (binary files, etc.)
          return null;
        }
      }),
    );

    const files: FileDiff[] = [];
    let insertions = 0;
    let deletions = 0;

    for (const file of results) {
      if (!file) continue;

      // Count rough insertions/deletions
      const oldLines = file.oldFile?.contents.split("\n").length ?? 0;
      const newLines = file.newFile?.contents.split("\n").length ?? 0;
      if (newLines > oldLines) {
        insertions += newLines - oldLines;
      } else {
        deletions += oldLines - newLines;
      }

      files.push(file);
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

    // Get status to determine file states
    const status = await git.status();

    // Get numstat for accurate insertions/deletions.
    // Kept sequential after `git status` on purpose: status refreshes and writes back
    // the index (.git/index.lock), so racing it against these diffs on the same repo
    // risks lock contention — not worth the few ms saved.
    // react-doctor-disable-next-line server-sequential-independent-await
    const [stagedNumstat, unstagedNumstat] = await Promise.all([
      git.diff(["--cached", "--numstat"]).catch(() => ""),
      git.diff(["--numstat"]).catch(() => ""),
    ]);

    // Parse numstat output: "insertions\tdeletions\tfilename"
    const parseNumstat = (
      output: string,
    ): Map<string, { insertions: number; deletions: number }> => {
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

    // Set lookup instead of repeated Array.includes scans below
    const stagedFiles = new Set(status.staged);

    // Helper to get file size
    const getFileSize = async (filePath: string): Promise<number> => {
      try {
        const stat = await fs.stat(nodePath.join(path, filePath));
        return stat.size;
      } catch {
        return 0;
      }
    };

    // Count lines of an untracked file (0 when binary or unreadable)
    const countLines = async (filePath: string): Promise<number> => {
      try {
        const content = await fs.readFile(nodePath.join(path, filePath), "utf-8");
        return content.split("\n").length;
      } catch {
        // Binary or unreadable
        return 0;
      }
    };

    type PendingFile = Omit<DiffFileInfo, "size" | "insertions"> & {
      /** null → resolve via fs.stat */
      size: number | null;
      /** null → resolve by counting lines of the untracked file */
      insertions: number | null;
    };

    // Track processed files to avoid duplicates
    const processedFiles = new Set<string>();
    const pending: PendingFile[] = [];

    // Process created files (staged new files)
    for (const file of status.created) {
      processedFiles.add(file);
      const stats = stagedStats.get(file) ?? { insertions: 0, deletions: 0 };
      pending.push({
        path: file,
        status: "added",
        staged: true,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size: null,
      });
    }

    // Process staged files (modified files that are staged)
    for (const file of status.staged) {
      if (processedFiles.has(file)) continue; // Skip created files already processed
      processedFiles.add(file);
      const stats = stagedStats.get(file) ?? { insertions: 0, deletions: 0 };
      pending.push({
        path: file,
        status: "modified",
        staged: true,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size: null,
      });
    }

    // Process modified files (unstaged)
    for (const file of status.modified) {
      if (processedFiles.has(file)) continue; // Already processed
      processedFiles.add(file);
      const stats = unstagedStats.get(file) ?? { insertions: 0, deletions: 0 };
      pending.push({
        path: file,
        status: "modified",
        staged: false,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size: null,
      });
    }

    // Process untracked files (line count derived from the file itself)
    for (const file of status.not_added) {
      if (processedFiles.has(file)) continue; // Already processed
      processedFiles.add(file);
      pending.push({
        path: file,
        status: "added",
        staged: false,
        insertions: null,
        deletions: 0,
        size: null,
      });
    }

    // Process deleted files
    for (const file of status.deleted) {
      if (processedFiles.has(file)) continue; // Already processed
      processedFiles.add(file);
      const isStaged = stagedFiles.has(file);
      const stats = (isStaged ? stagedStats : unstagedStats).get(file) ?? {
        insertions: 0,
        deletions: 0,
      };
      pending.push({
        path: file,
        status: "deleted",
        staged: isStaged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size: 0,
      });
    }

    // Process renamed files
    for (const renamed of status.renamed) {
      if (processedFiles.has(renamed.to)) continue; // Already processed
      processedFiles.add(renamed.to);
      const isStaged = stagedFiles.has(renamed.to);
      const stats = (isStaged ? stagedStats : unstagedStats).get(renamed.to) ?? {
        insertions: 0,
        deletions: 0,
      };
      pending.push({
        path: renamed.to,
        status: "renamed",
        staged: isStaged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        size: null,
      });
    }

    // Resolve sizes / untracked line counts in parallel; these are read-only
    // filesystem lookups, so they cannot race with each other. Order is preserved.
    const files: DiffFileInfo[] = await Promise.all(
      pending.map(async (file): Promise<DiffFileInfo> => {
        const [size, insertions] = await Promise.all([
          file.size ?? getFileSize(file.path),
          file.insertions ?? countLines(file.path),
        ]);
        return { ...file, size, insertions };
      }),
    );

    let totalInsertions = 0;
    let totalDeletions = 0;
    for (const file of files) {
      totalInsertions += file.insertions;
      totalDeletions += file.deletions;
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
  async getFileDiff(repoPath: string, filePath: string, staged = false): Promise<FileDiffContent> {
    const git = this.getGit(repoPath);

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
      const isBinary = (content: string | null) => content !== null && content.includes("\0");

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
