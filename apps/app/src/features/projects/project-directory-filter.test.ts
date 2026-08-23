import { describe, expect, it } from "vitest";

import {
  isProjectDirectoryEntryVisible,
  type ProjectDirectoryEntry,
  projectDirectoryEntryMatches,
} from "./project-directory-filter";

const hidden: ProjectDirectoryEntry = {
  value: "/Users/dinq/.herdr",
  label: ".herdr",
  kind: "dir",
};

const regular: ProjectDirectoryEntry = {
  value: "/Users/dinq/Code",
  label: "Code",
  kind: "dir",
};

describe("project directory filter", () => {
  it("hides dotfolders until the search starts with a dot", () => {
    expect(isProjectDirectoryEntryVisible(hidden, "")).toBe(false);
    expect(isProjectDirectoryEntryVisible(hidden, "herdr")).toBe(false);
    expect(isProjectDirectoryEntryVisible(hidden, ".")).toBe(true);
    expect(isProjectDirectoryEntryVisible(hidden, ".her")).toBe(true);
    expect(isProjectDirectoryEntryVisible(regular, "")).toBe(true);
  });

  it("reveals and matches a dotfolder searched by its full path", () => {
    expect(isProjectDirectoryEntryVisible(hidden, hidden.value)).toBe(true);
    expect(isProjectDirectoryEntryVisible(hidden, `${hidden.value}/`)).toBe(true);
    expect(projectDirectoryEntryMatches(hidden, hidden.value)).toBe(true);
    expect(projectDirectoryEntryMatches(hidden, `${hidden.value}/`)).toBe(true);
  });
});
