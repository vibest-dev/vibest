import { describe, expect, it } from "vitest";

import {
  getReviewFileTree,
  isOpenableTreeEntry,
  symlinkDescription,
  syncReviewFileTree,
  toPierrePath,
  unionDeletedReviewEntries,
} from "./review-tree";

describe("review file tree", () => {
  it("converts directory paths to Pierre directory identifiers", () => {
    expect(toPierrePath({ path: "src", type: "directory" })).toBe("src/");
    expect(toPierrePath({ path: "src/index.ts", type: "file" })).toBe("src/index.ts");
  });

  it("adds deleted review paths that are gone from the workspace tree", () => {
    const entries = unionDeletedReviewEntries(
      [
        { path: "src", type: "directory" },
        { path: "src/keep.ts", type: "file" },
      ],
      [
        { path: "src/gone.ts", status: "deleted" },
        { path: "legacy/old.ts", status: "deleted" },
        { path: "src/keep.ts", status: "modified" },
      ],
    );
    expect(entries).toEqual([
      { path: "src", type: "directory" },
      { path: "src/keep.ts", type: "file" },
      { path: "src/gone.ts", type: "file" },
      { path: "legacy", type: "directory" },
      { path: "legacy/old.ts", type: "file" },
    ]);
  });

  it("preserves expanded directories across complete tree resets", () => {
    const state = getReviewFileTree(`test-${crypto.randomUUID()}`);
    syncReviewFileTree(
      state,
      [
        { path: "src", type: "directory" },
        { path: "src/index.ts", type: "file" },
      ],
      [],
    );

    const src = state.model.getItem("src/");
    expect(src?.isDirectory()).toBe(true);
    if (src === null || !src.isDirectory() || !("expand" in src)) {
      throw new Error("src directory missing");
    }
    src.expand();

    syncReviewFileTree(
      state,
      [
        { path: "README.md", type: "file" },
        { path: "src", type: "directory" },
        { path: "src/index.ts", type: "file" },
        { path: "src/new.ts", type: "file" },
      ],
      [{ path: "src/new.ts", status: "added" }],
    );

    const refreshedSrc = state.model.getItem("src/");
    expect(refreshedSrc?.isDirectory()).toBe(true);
    if (refreshedSrc === null || !refreshedSrc.isDirectory() || !("isExpanded" in refreshedSrc)) {
      throw new Error("refreshed src directory missing");
    }
    expect(refreshedSrc.isExpanded()).toBe(true);
    state.model.cleanUp();
  });

  it("describes why non-file symlinks cannot be opened", () => {
    expect(
      symlinkDescription({ path: "dir-link", type: "symlink", symlinkTarget: "directory" }),
    ).toContain("disabled");
  });

  it("treats regular files as openable", () => {
    expect(isOpenableTreeEntry({ path: "a.ts", type: "file" })).toBe(true);
  });
});
