import { describe, expect, it } from "vitest";

import {
  getSessionFileTree,
  isOpenableTreeEntry,
  symlinkDescription,
  syncSessionFileTree,
  toPierrePath,
} from "./session-file-tree";

describe("session file tree", () => {
  it("converts directory paths to Pierre directory identifiers", () => {
    expect(toPierrePath({ path: "src", type: "directory" })).toBe("src/");
    expect(toPierrePath({ path: "src/index.ts", type: "file" })).toBe("src/index.ts");
  });

  it("preserves expanded directories across complete tree resets", () => {
    const state = getSessionFileTree(`test-${crypto.randomUUID()}`);
    syncSessionFileTree(state, [
      { path: "src", type: "directory" },
      { path: "src/index.ts", type: "file" },
    ]);

    const src = state.model.getItem("src/");
    expect(src?.isDirectory()).toBe(true);
    if (src === null || !src.isDirectory() || !("expand" in src)) {
      throw new Error("src directory missing");
    }
    src.expand();

    syncSessionFileTree(state, [
      { path: "README.md", type: "file" },
      { path: "src", type: "directory" },
      { path: "src/index.ts", type: "file" },
      { path: "src/new.ts", type: "file" },
    ]);

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
    expect(
      symlinkDescription({ path: "outside", type: "symlink", symlinkTarget: "outside" }),
    ).toContain("disabled");
    expect(
      symlinkDescription({ path: "broken", type: "symlink", symlinkTarget: "broken" }),
    ).toContain("disabled");
  });

  it("only opens regular files and in-workspace file symlinks", () => {
    expect(isOpenableTreeEntry({ path: "a.ts", type: "file" })).toBe(true);
    expect(isOpenableTreeEntry({ path: "a-link", type: "symlink", symlinkTarget: "file" })).toBe(
      true,
    );
    expect(
      isOpenableTreeEntry({ path: "dir-link", type: "symlink", symlinkTarget: "directory" }),
    ).toBe(false);
    expect(
      isOpenableTreeEntry({ path: "outside", type: "symlink", symlinkTarget: "outside" }),
    ).toBe(false);
  });
});
