import { describe, expect, it } from "vitest";

import {
  emptyReviewMessage,
  isReviewMode,
  pierreGitStatus,
  reviewHeading,
  splitCompareRefs,
} from "./review-file-status";

describe("reviewHeading", () => {
  it("names uncommitted work on the current branch", () => {
    expect(
      reviewHeading({ mode: "uncommitted", branch: "main", baseBranch: null, other: null }),
    ).toBe("Uncommitted changes on main");
  });

  it("names a committed review against its base", () => {
    expect(
      reviewHeading({
        mode: "committed",
        branch: "feature/auth",
        baseBranch: "origin/main",
        other: null,
      }),
    ).toBe("feature/auth → origin/main");
  });

  it("names a branch comparison including remotes", () => {
    expect(
      reviewHeading({
        mode: "branch",
        branch: "feature/auth",
        baseBranch: "origin/main",
        other: "origin/main",
      }),
    ).toBe("feature/auth → origin/main");
  });

  it("falls back when the branch name is missing", () => {
    expect(
      reviewHeading({ mode: "uncommitted", branch: null, baseBranch: null, other: null }),
    ).toBe("Uncommitted changes");
  });
});

describe("emptyReviewMessage", () => {
  it("explains a clean working tree", () => {
    expect(emptyReviewMessage({ mode: "uncommitted", baseBranch: null, other: null })).toBe(
      "The working tree matches HEAD.",
    );
  });
});

describe("isReviewMode", () => {
  it("accepts the three compare modes", () => {
    expect(isReviewMode("uncommitted")).toBe(true);
    expect(isReviewMode("committed")).toBe(true);
    expect(isReviewMode("branch")).toBe(true);
    expect(isReviewMode("pr")).toBe(false);
  });
});

describe("splitCompareRefs", () => {
  it("keeps slashed local names out of the remote group", () => {
    expect(
      splitCompareRefs(
        ["main", "feature/oauth", "origin/main", "origin/HEAD"],
        ["origin/main", "origin/HEAD"],
      ),
    ).toEqual({
      local: ["main", "feature/oauth"],
      remote: ["origin/main", "origin/HEAD"],
    });
  });
});

describe("pierreGitStatus", () => {
  it("maps copied to modified because Pierre has no copied badge", () => {
    expect(pierreGitStatus("copied")).toBe("modified");
    expect(pierreGitStatus("renamed")).toBe("renamed");
  });
});
