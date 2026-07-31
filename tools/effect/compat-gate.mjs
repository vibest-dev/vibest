#!/usr/bin/env node
// Effect compatibility gate (issue #161). The app runs on an exact Effect v4
// beta and uses unstable modules in production, so version drift compiles fine
// and only fails at runtime. This script makes drift a dependency-policy
// failure instead: it verifies that the catalog, the overrides, every
// workspace manifest, and the lockfile agree on exactly one Effect runtime.
//
// Checks, in order:
//   1. `effect`, `@effect/platform-node`, `@effect/vitest` are catalog-pinned
//      to one identical exact version (no ranges) — the compatibility set.
//   2. Each of them has a `catalog:` override, so transitive resolutions
//      cannot introduce a second runtime (see the comment in
//      pnpm-workspace.yaml).
//   3. No workspace package.json declares an Effect-family dependency outside
//      `catalog:`.
//   4. The lockfile resolves exactly one `effect` version — the pinned one —
//      across snapshots and peer suffixes, and every other `@effect/*`
//      package resolves to a single version.
//
// Runs from a bare checkout (no install needed): `node tools/effect/compat-gate.mjs`.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

/** The pinned family: exact catalog pin + override, moved together in one PR. */
const PINNED_FAMILY = ["effect", "@effect/platform-node", "@effect/vitest"];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const errors = [];

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

/** Entries of a flat top-level block ("catalog:", "overrides:") in pnpm-workspace.yaml. */
function topLevelEntries(yamlText, blockKey) {
  const lines = yamlText.split("\n");
  const start = lines.indexOf(`${blockKey}:`);
  const entries = new Map();
  if (start === -1) return entries;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith("  ")) break;
    const match = line.match(/^ {2}"?([^":]+)"?:\s*(?:"([^"]*)"|(\S+))\s*$/);
    if (match) entries.set(match[1], match[2] ?? match[3]);
  }
  return entries;
}

const workspaceYaml = read("pnpm-workspace.yaml");
const catalog = topLevelEntries(workspaceYaml, "catalog");
const overrides = topLevelEntries(workspaceYaml, "overrides");

// 1. Exact, identical catalog pins.
const pins = new Map();
for (const name of PINNED_FAMILY) {
  const version = catalog.get(name);
  if (version === undefined) {
    errors.push(`${name} is missing from the catalog in pnpm-workspace.yaml`);
  } else if (!EXACT_VERSION.test(version)) {
    errors.push(
      `${name} catalog entry "${version}" is a range — the Effect family needs an exact pin`,
    );
  } else {
    pins.set(name, version);
  }
}
const distinctPins = new Set(pins.values());
if (distinctPins.size > 1) {
  const listed = [...pins].map(([name, version]) => `${name}@${version}`).join(", ");
  errors.push(`the Effect family must share one version, got: ${listed}`);
}
const pinned = distinctPins.size === 1 ? [...distinctPins][0] : undefined;

// 2. Overrides force transitive resolutions onto the catalog.
for (const name of PINNED_FAMILY) {
  if (overrides.get(name) !== "catalog:") {
    errors.push(`${name} needs an override to "catalog:" in pnpm-workspace.yaml`);
  }
}

// 3. Workspace manifests declare the family only via catalog:.
const packageDirs = ["apps", "packages", "tools"].flatMap((group) => {
  const groupDir = path.join(root, group);
  if (!fs.existsSync(groupDir)) return [];
  return fs
    .readdirSync(groupDir)
    .map((entry) => path.join(group, entry, "package.json"))
    .filter((manifest) => fs.existsSync(path.join(root, manifest)));
});
for (const manifestPath of packageDirs) {
  const manifest = JSON.parse(read(manifestPath));
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const isFamily = name === "effect" || name.startsWith("@effect/");
      if (isFamily && spec !== "catalog:") {
        errors.push(
          `${manifestPath} declares ${name}: "${spec}" — Effect-family deps must use "catalog:"`,
        );
      }
    }
  }
}

// 4. The lockfile installs exactly one Effect runtime.
const lockfile = read("pnpm-lock.yaml");

/** Every resolved `effect@<version>` occurrence: snapshot/package keys and peer suffixes. */
function collectVersions(text, pattern) {
  const versions = new Map();
  for (const match of text.matchAll(pattern)) {
    const [, , name, version] = match;
    const key = name === "" ? "effect" : name;
    if (!versions.has(key)) versions.set(key, new Set());
    versions.get(key).add(version);
  }
  return versions;
}

const runtimeVersions =
  collectVersions(lockfile, /(^|[\s'"(])()effect@([^\s'"():]+)/gm).get("effect") ?? new Set();
if (runtimeVersions.size === 0) {
  errors.push("no resolved effect version found in pnpm-lock.yaml");
} else if (runtimeVersions.size > 1) {
  errors.push(`multiple effect runtimes in pnpm-lock.yaml: ${[...runtimeVersions].join(", ")}`);
} else if (pinned !== undefined && !runtimeVersions.has(pinned)) {
  errors.push(
    `lockfile resolves effect@${[...runtimeVersions][0]} but the catalog pins ${pinned} — reinstall`,
  );
}

const familyVersions = collectVersions(
  lockfile,
  /(^|[\s'"(])(@effect\/[A-Za-z0-9._-]+)@([^\s'"():]+)/gm,
);
for (const [name, versions] of familyVersions) {
  if (versions.size > 1) {
    errors.push(`multiple versions of ${name} in pnpm-lock.yaml: ${[...versions].join(", ")}`);
  }
}
for (const name of PINNED_FAMILY) {
  const versions = familyVersions.get(name);
  if (name === "effect" || versions === undefined) continue;
  const [resolved] = [...versions];
  if (pinned !== undefined && versions.size === 1 && resolved !== pinned) {
    errors.push(`lockfile resolves ${name}@${resolved} but the catalog pins ${pinned} — reinstall`);
  }
}

if (errors.length > 0) {
  console.error("Effect compatibility gate failed:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Upgrade procedure: docs/effect-upgrade.md");
  process.exit(1);
}

console.log(
  `Effect compatibility gate passed: one runtime (effect@${[...runtimeVersions][0]}), ` +
    `${familyVersions.size} @effect/* packages in lockstep`,
);
