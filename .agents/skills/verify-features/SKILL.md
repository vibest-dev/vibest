---
name: verify-features
description: Lead a verification of vibest against its capabilities in docs/features, using pnpm verify and the E2E checks as tools and checking the rest by hand in an isolated real environment, then write one report with every capability id verified, failed or not verified, and its evidence. Use to say a change works, before a release, or when asked whether vibest (or one area of it) works.
---

# Verify features

The capabilities are in `docs/features/<area>.md`: each `## <ID>. <name>` says what the capability is and when it counts
as working. That text is the authority. Scripts are your tools; you lead the verification and judge each capability
against its text.

## 1. Scope

Read every file in `docs/features/` (or the areas you were asked about). List each capability id with its "counts as
working" condition. That list is the report's skeleton; every id in scope ends up verified, failed or not verified.

## 2. Run the gate

From the checkout, run `pnpm verify` to the end (about 10 to 15 minutes; run it in the background and wait for its exit,
do not end your turn while it runs). Keep its output. Its E2E legs write `tools/e2e/evidence/<run>/report.json` (each
check's id, outcome and detail) and the commands each check ran. A failed or skipped gate is a finding, not a reason to
stop: record it and go on.

## 3. Map script results to capabilities

`bun tools/e2e/src/main.ts --list` prints every E2E check's id, tier and `covers`. A check is about the capability whose
id starts its name (`S10-start` is about `S10`) and also about each id in its `covers`. For each capability:

- Read the checks about it (`tools/e2e/src/scenarios/`) and compare what they assert with the capability's text. A
  passing check is evidence only for what it asserts; where the text says more, the rest is still open.
- Unit tests count only where docs/testing/e2e-plan.md §5 names one for that capability, and only when `pnpm test`
  passed in this run.
- A capability is verified by scripts only when every part of its text is covered by passing checks of this run.

## 4. Verify the rest by hand

For each capability or part no script covered (docs/testing/e2e-plan.md §5 lists the known ones: D9, I5, I10, S39),
follow its text in a real environment and record what you ran and saw.

- Isolation: the rules of AGENTS.md and docs/testing/e2e-plan.md §1 apply. Use a temp `VIBEST_HOME`, your own herdr
  session (always pass `--session`), shadow harness config; never the user's `~/.vibest`, herdr session or harness
  config. Prefer `pnpm e2e --tier agent <id>` where such a check exists; it builds that world for you.
- A real model only where the capability needs one (I5, I10 on the user's own Cursor login, read only).
- A capability that needs something you cannot get (D9 needs a newer release published to npm; a missing login) is
  not verified, with the reason. Never mark it verified.

## 5. Report

Write one report per run to `tools/e2e/evidence/<UTC time>-features/report.md` (create the folder):

- the commit (`git rev-parse HEAD`), the date, and the `pnpm verify` exit status with its evidence folders;
- one line per capability id in scope, in the order of `docs/features`: `<ID> verified|failed|not verified`, then the
  evidence: the passing or failing check ids with their evidence folder, or the commands you ran and the output or pane
  text you saw, or why it was not verified;
- for each failure, what the text says and what happened instead.

A capability without evidence is not verified. Report the counts (verified, failed, not verified) and the failures
first when you hand the report back.
