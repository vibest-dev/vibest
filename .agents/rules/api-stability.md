# API Stability

Every vibest API is experimental until vibest declares it stable: the plugin API (`@vibest/plugin`), the RPC protocol
and its methods, the CLI commands and their JSON output, the configuration file (`vibest.json`) and the database shape.

1. Until an API is declared stable, it may change in any release, without aliases or a deprecation period.
2. A change that breaks any of these APIs adds a note under `## Unreleased` → `### Breaking changes` in the root
   `CHANGELOG.md`: what changed, who is affected (plugin authors, scripts reading CLI JSON, users of a command or a
   config key), and how to migrate. The owner renames `Unreleased` to the version when releasing; agents never release
   ([release.md](release.md) 2).
3. No name gets an `experimental.` prefix while everything is experimental: the prefix would carry no information.
4. From the moment an API is declared stable (per API, for example "the plugin API is stable as of 1.0"), new hooks,
   domains, RPC methods, fields and default behaviours on it start experimental and are named `experimental.*` (hooks
   `experimental.<domain>.<name>`, fields under an `experimental` key); they may change or go without aliases and
   graduate by dropping the prefix with a changelog note. A breaking move of a stable name keeps the old one as a
   `@deprecated` alias naming the replacement, removed in the next minor.

Status: in force; no API is declared stable yet.
