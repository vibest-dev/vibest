import type { GitReviewFile, GitReviewFileStatus } from "@vibest/contract/git";

const statusFromLetter = (letter: string): GitReviewFileStatus => {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  if (letter === "C") return "copied";
  return "modified";
};

/**
 * Parse `git diff --name-status -z --find-renames` output. Rename/copy
 * records are `STATUS\0old\0new\0`; everything else is `STATUS\0path\0`.
 */
export function parseNameStatus(raw: string): GitReviewFile[] {
  if (raw === "") return [];
  const parts = raw.split("\0");
  const files: GitReviewFile[] = [];
  let index = 0;
  while (index < parts.length) {
    const code = parts[index];
    if (code === undefined || code === "") {
      index += 1;
      continue;
    }
    const letter = code[0] ?? "";
    if (letter === "R" || letter === "C") {
      const oldPath = parts[index + 1];
      const nextPath = parts[index + 2];
      if (oldPath !== undefined && oldPath !== "" && nextPath !== undefined && nextPath !== "") {
        files.push({ path: nextPath, status: statusFromLetter(letter), oldPath });
      }
      index += 3;
      continue;
    }
    const nextPath = parts[index + 1];
    if (nextPath !== undefined && nextPath !== "") {
      files.push({ path: nextPath, status: statusFromLetter(letter) });
    }
    index += 2;
  }
  return files;
}

export function parseNulPaths(raw: string): string[] {
  return raw.split("\0").filter((entry) => entry !== "");
}
