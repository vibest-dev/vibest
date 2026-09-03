import { describe, expect, it } from "vitest";

import { parseNameStatus, parseNulPaths } from "../src/git/name-status";

describe("parseNameStatus", () => {
  it("parses modified, added, and deleted records", () => {
    expect(parseNameStatus("M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0")).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
      { path: "src/c.ts", status: "deleted" },
    ]);
  });

  it("parses rename and copy records with the old path", () => {
    expect(parseNameStatus("R100\0old.ts\0new.ts\0C080\0src/a.ts\0src/a-copy.ts\0")).toEqual([
      { path: "new.ts", status: "renamed", oldPath: "old.ts" },
      { path: "src/a-copy.ts", status: "copied", oldPath: "src/a.ts" },
    ]);
  });

  it("treats type changes as modified", () => {
    expect(parseNameStatus("T\0script\0")).toEqual([{ path: "script", status: "modified" }]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("parseNulPaths", () => {
  it("splits untracked paths and drops empties", () => {
    expect(parseNulPaths("notes.md\0tmp/a.ts\0")).toEqual(["notes.md", "tmp/a.ts"]);
  });
});
