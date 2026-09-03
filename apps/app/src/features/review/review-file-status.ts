import type { GitReviewFile, GitReviewFileStatus, GitReviewMode } from "@vibest/contract/git";

export const REVIEW_STATUS_LABEL: Record<GitReviewFileStatus, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
};

export const REVIEW_STATUS_BADGE: Record<GitReviewFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

export const REVIEW_MODE_ITEMS = [
  { value: "uncommitted", label: "Uncommitted" },
  { value: "committed", label: "Committed" },
  { value: "branch", label: "vs branch" },
] as const;

export function isReviewMode(value: unknown): value is GitReviewMode {
  return value === "uncommitted" || value === "committed" || value === "branch";
}

export function reviewHeading(review: {
  mode: GitReviewMode;
  branch: string | null;
  baseBranch: string | null;
  other: string | null;
}): string {
  switch (review.mode) {
    case "uncommitted":
      return review.branch === null
        ? "Uncommitted changes"
        : `Uncommitted changes on ${review.branch}`;
    case "committed":
      if (review.branch !== null && review.baseBranch !== null) {
        return `${review.branch} → ${review.baseBranch}`;
      }
      return "Committed changes";
    case "branch": {
      const target = review.other ?? review.baseBranch;
      if (review.branch !== null && target !== null) return `${review.branch} → ${target}`;
      return "Branch comparison";
    }
  }
}

export function emptyReviewMessage(review: {
  mode: GitReviewMode;
  baseBranch: string | null;
  other: string | null;
}): string {
  switch (review.mode) {
    case "uncommitted":
      return "The working tree matches HEAD.";
    case "committed":
      return review.baseBranch === null
        ? "HEAD matches the default branch."
        : `This branch has no committed changes against ${review.baseBranch}.`;
    case "branch": {
      const target = review.other ?? review.baseBranch;
      return target === null
        ? "No changes against the selected branch."
        : `No changes against ${target}.`;
    }
  }
}

export function splitCompareRefs(
  branches: ReadonlyArray<string>,
  remotes: ReadonlyArray<string>,
): {
  local: string[];
  remote: string[];
} {
  const remoteSet = new Set(remotes);
  const local: string[] = [];
  const remote: string[] = [];
  for (const name of branches) {
    if (remoteSet.has(name)) remote.push(name);
    else local.push(name);
  }
  return { local, remote };
}

export function pierreGitStatus(
  status: GitReviewFileStatus,
): "added" | "deleted" | "modified" | "renamed" {
  return status === "copied" ? "modified" : status;
}

export function reviewGitStatusEntries(
  files: ReadonlyArray<GitReviewFile>,
): ReadonlyArray<{ path: string; status: ReturnType<typeof pierreGitStatus> }> {
  return files.map((file) => ({ path: file.path, status: pierreGitStatus(file.status) }));
}
