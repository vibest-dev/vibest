import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Workspace rule: a dependency declared in the root package.json is workspace
// infrastructure (typescript, vite, vitest, ...) and must not be re-declared
// by any workspace package — pnpm puts the root node_modules/.bin on every
// package script's PATH and module resolution walks up, so a second
// declaration only reintroduces version drift.

const rootDir = path.dirname(import.meta.dirname);
const readPkg = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const root = readPkg(path.join(rootDir, "package.json"));
const rootDeps = new Set([
  ...Object.keys(root.dependencies ?? {}),
  ...Object.keys(root.devDependencies ?? {}),
]);

const packageFiles = ["apps", "packages", "tools"].flatMap((group) => {
  const dir = path.join(rootDir, group);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name, "package.json"))
    .filter((file) => fs.existsSync(file));
});

const violations = [];
for (const file of packageFiles) {
  const pkg = readPkg(file);
  for (const section of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (rootDeps.has(name)) {
        violations.push(`${path.relative(rootDir, file)} [${section}]: ${name}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Dependencies declared at the workspace root must not be re-declared by packages:");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error("Remove them from the package — the root installation is already on the PATH.");
  process.exit(1);
}

console.log(`check-deps: ${packageFiles.length} packages clean`);
