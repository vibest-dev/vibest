# Node Builtin Imports

Enforced by `unicorn/prefer-node-protocol` and `vibest/node-import-style` (`tools/oxlint/node-import-style.mjs`).

1. Import a Node builtin with the `node:` prefix as one default import under its canonical name, and call members at the use site: `import fs from "node:fs/promises"`, then `fs.rename(…)`. Named, namespace and re-exported builtin imports are refused, and so are ad-hoc local names (`nodePath`, `NodeAssert`). Type-only imports are exempt: types have no runtime binding.
2. The canonical name is the module's first path segment, camelCased: `child_process` is `childProcess`, `fs/promises` is `fs`, `assert/strict` is `assert`. Only when one file imports two builtins with the same first segment (`node:fs` and `node:fs/promises`) does the subpath import take its full camelCased path (`fsPromises`).
3. These rules cannot be switched off with a comment: `vibest/no-restricted-disable` refuses a disable directive that names them, and any blanket disable, which would turn them off too. It compares only the last segment of a rule name, because oxlint accepts a rule without its plugin prefix or under another plugin's prefix (`prefer-node-protocol`, `node/prefer-node-protocol`). Fix the import instead.
