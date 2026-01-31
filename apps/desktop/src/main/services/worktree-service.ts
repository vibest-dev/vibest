import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";

import type { GitService } from "./git-service";
import type { StoreService } from "./store-service";

import { pathToId, type StoredWorktree } from "../../shared/types";

// Place names pool (200+ cities)
const PLACE_NAMES = [
  // Major world cities
  "tokyo",
  "paris",
  "london",
  "sydney",
  "berlin",
  "rome",
  "osaka",
  "seoul",
  "dubai",
  "mumbai",
  "cairo",
  "rio",
  "lima",
  "oslo",
  "vienna",
  "prague",
  "athens",
  "lisbon",
  "amsterdam",
  "barcelona",
  "milan",
  "zurich",
  "geneva",
  "singapore",
  "bangkok",
  "jakarta",
  "manila",
  "hanoi",
  "taipei",
  "hongkong",
  "moscow",
  "istanbul",
  "shanghai",
  "beijing",
  "toronto",
  "vancouver",
  "seattle",
  "denver",
  "chicago",
  "boston",
  "miami",
  "atlanta",
  "phoenix",
  "dallas",
  "houston",
  "portland",
  "austin",
  "nashville",
  "detroit",
  "melbourne",
  "auckland",
  "wellington",
  "perth",
  "brisbane",
  "cape-town",
  "johannesburg",
  "nairobi",
  "lagos",
  "marrakech",
  "tunis",
  "algiers",
  "casablanca",
  "edinburgh",
  "dublin",
  "belfast",
  "cardiff",
  "manchester",
  "liverpool",
  "birmingham",
  "leeds",
  "bristol",
  "glasgow",
  "lyon",
  "marseille",
  "bordeaux",
  "nice",
  "toulouse",
  "nantes",
  "strasbourg",
  "munich",
  "hamburg",
  "cologne",
  "frankfurt",
  "dresden",
  "leipzig",
  "stuttgart",
  "nuremberg",
  "salzburg",
  "innsbruck",
  "graz",
  "linz",
  "bruges",
  "ghent",
  "antwerp",
  "rotterdam",
  "utrecht",
  "eindhoven",
  "copenhagen",
  "stockholm",
  "gothenburg",
  "malmo",
  "helsinki",
  "tallinn",
  "riga",
  "vilnius",
  "warsaw",
  "krakow",
  "gdansk",
  "wroclaw",
  "poznan",
  "bratislava",
  "budapest",
  "bucharest",
  "sofia",
  "belgrade",
  "zagreb",
  "ljubljana",
  "sarajevo",
  "skopje",
  "tirana",
  "podgorica",
  "pristina",
  "nicosia",
  "valletta",
  "reykjavik",
  "nuuk",
  "juneau",
  "anchorage",
  "honolulu",
  "fairbanks",
  "sitka",
  "ketchikan",
  "kodiak",
  "nome",
  "barrow",
  "bethel",
  "valdez",
  "seward",
  "homer",
  "kenai",
  "soldotna",
  "wasilla",
  "palmer",
  "girdwood",
  "talkeetna",
  "denali",
  "katmai",
  "wrangell",
  "petersburg",
  "haines",
  "skagway",
  "yakutat",
  "cordova",
  "whittier",
  "tok",
  "mccarthy",
  "tanana",
  "galena",
  "ruby",
  "huslia",
  "nulato",
  "kaltag",
  "kyoto",
  "nagoya",
  "sapporo",
  "kobe",
  "yokohama",
  "fukuoka",
  "sendai",
  "hiroshima",
  "nara",
  "kanazawa",
  "hakodate",
  "okinawa",
  "kumamoto",
  "nagasaki",
  "matsuyama",
  "shizuoka",
  "niigata",
  "hamamatsu",
  "okayama",
  "chiba",
  "kawasaki",
  "saitama",
  "busan",
  "incheon",
  "daegu",
  "daejeon",
  "gwangju",
  "ulsan",
  "suwon",
  "jeju",
  "chengdu",
  "shenzhen",
  "guangzhou",
  "hangzhou",
  "nanjing",
  "xian",
  "wuhan",
  "chongqing",
  "tianjin",
  "suzhou",
  "qingdao",
  "dalian",
  "xiamen",
  "kunming",
  "fuzhou",
  "zhengzhou",
  "changsha",
  "jinan",
];

function getAvailablePlaceName(usedNames: string[]): string {
  // First try to find an unused name from the pool
  const available = PLACE_NAMES.filter((n) => !usedNames.includes(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }

  // If pool is exhausted, use {placeName}-{number} format
  const baseName = PLACE_NAMES[Math.floor(Math.random() * PLACE_NAMES.length)];
  let suffix = 2;
  while (usedNames.includes(`${baseName}-${suffix}`)) {
    suffix++;
  }
  return `${baseName}-${suffix}`;
}

function getWorktreeBasePath(): string {
  return join(homedir(), "vibest", "workspaces");
}

export class WorktreeService {
  constructor(
    private store: StoreService,
    _git: GitService,
  ) {}

  generateWorktreePath(repoName: string, usedNames: string[]): { path: string; placeName: string } {
    const placeName = getAvailablePlaceName(usedNames);
    const path = join(getWorktreeBasePath(), repoName, placeName);
    return { path, placeName };
  }

  async listWorktrees(repositoryPath: string): Promise<Array<{ path: string; branch: string }>> {
    const git = simpleGit(repositoryPath);

    try {
      // Use git worktree list --porcelain for parseable output
      const result = await git.raw(["worktree", "list", "--porcelain"]);
      const worktrees: Array<{ path: string; branch: string }> = [];

      const entries = result.trim().split("\n\n");

      for (const entry of entries) {
        if (!entry.trim()) continue;

        const lines = entry.split("\n");
        let path = "";
        let branch = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            path = line.substring(9);
          } else if (line.startsWith("branch ")) {
            // Format: branch refs/heads/branch-name
            branch = line.substring(7).replace("refs/heads/", "");
          }
        }

        // Skip the main worktree (repository path itself)
        if (path && path !== repositoryPath) {
          worktrees.push({ path, branch });
        }
      }

      return worktrees;
    } catch (error) {
      console.error("Error listing worktrees:", error);
      return [];
    }
  }

  async createWorktree(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    isNewBranch: boolean,
    baseBranch?: string,
  ): Promise<void> {
    const git = simpleGit(repositoryPath);

    if (isNewBranch) {
      // Determine the base ref
      let base = baseBranch || "HEAD";

      // If baseBranch is specified, check if it exists locally
      // If not, try origin/{baseBranch}
      if (baseBranch) {
        try {
          // Check if local branch exists
          await git.raw(["rev-parse", "--verify", baseBranch]);
        } catch {
          // Local branch doesn't exist, try remote
          try {
            await git.raw(["rev-parse", "--verify", `origin/${baseBranch}`]);
            base = `origin/${baseBranch}`;
          } catch {
            // Neither exists, fallback to HEAD
            base = "HEAD";
          }
        }
      }

      await git.raw(["worktree", "add", "-b", branch, worktreePath, base]);
    } else {
      // Use existing branch
      await git.raw(["worktree", "add", worktreePath, branch]);
    }
  }

  async removeWorktree(repositoryPath: string, worktreePath: string, force = false): Promise<void> {
    const git = simpleGit(repositoryPath);
    const args = ["worktree", "remove", worktreePath];
    if (force) {
      args.push("--force");
    }
    await git.raw(args);
  }

  async safeRemoveWorktree(
    repositoryPath: string,
    worktreePath: string,
    force = false,
  ): Promise<void> {
    if (existsSync(worktreePath)) {
      await this.removeWorktree(repositoryPath, worktreePath, force);
    }
  }

  async safeArchiveWorktree(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    commitFirst: boolean,
    gitService: GitService,
  ): Promise<void> {
    if (existsSync(worktreePath)) {
      if (commitFirst) {
        await gitService.commitAll(worktreePath, "WIP: Auto-commit before archive");
      }
      await this.removeWorktree(repositoryPath, worktreePath, true);
      await gitService.deleteBranch(repositoryPath, branch);
    }
  }

  async syncWorktreesWithStore(
    repositoryId: string,
    repositoryPath: string,
    _repoName: string,
  ): Promise<StoredWorktree[]> {
    // Get actual worktrees from git
    const gitWorktrees = await this.listWorktrees(repositoryPath);

    // Only include worktrees under our workspace directory
    const workspaceBase = getWorktreeBasePath();
    const managedWorktrees = gitWorktrees.filter((wt) => wt.path.startsWith(workspaceBase));

    // Get stored worktrees
    const storedWorktrees = this.store.getWorktreesByRepositoryId(repositoryId);

    // Create a map of stored worktrees by path
    const storedMap = new Map(storedWorktrees.map((w) => [w.path, w]));

    // Sync: add any git worktrees not in store
    const result: StoredWorktree[] = [];

    for (const gitWt of managedWorktrees) {
      const existing = storedMap.get(gitWt.path);
      if (existing) {
        // Update branch if changed
        if (existing.branch !== gitWt.branch) {
          const updated = { ...existing, branch: gitWt.branch };
          this.store.removeWorktree(existing.id);
          this.store.addWorktree(updated);
          result.push(updated);
        } else {
          result.push(existing);
        }
        storedMap.delete(gitWt.path);
      } else {
        // New worktree found in git, add to store
        const newWorktree: StoredWorktree = {
          id: pathToId(gitWt.path),
          repositoryId,
          path: gitWt.path,
          branch: gitWt.branch,
        };
        this.store.addWorktree(newWorktree);
        result.push(newWorktree);
      }
    }

    // Remove any stored worktrees that no longer exist in git
    for (const [, orphan] of storedMap) {
      this.store.removeWorktree(orphan.id);
    }

    return result;
  }

  getPlaceNamePool(): string[] {
    return [...PLACE_NAMES];
  }
}
