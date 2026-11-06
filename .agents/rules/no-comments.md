# No Comments

Code carries no comments. `vibest/no-comments` (`tools/oxlint/no-comments.mjs`) fails `pnpm lint` on every line, block and JSDoc comment in the repository's TypeScript and JavaScript (`pnpm lint` runs `oxlint .`).

1. Allowed, because they have no other syntax: TypeScript directives (`// @ts-expect-error <reason>`, `@ts-ignore`, `@ts-nocheck`, `@ts-check`), `/// <reference … />`, oxlint/eslint disable directives (still limited by `vibest/no-restricted-disable`; put the reason after `--`), and their enable directives. A shebang is not a comment. Code oxlint ignores (`ignorePatterns` in `.oxlintrc.json`: generated code, and the TypeScript sketches under `docs/`, which are documents) is not checked.
2. Say it in code first: a name for the function, variable, type or constant that states the reason, an extracted function named after the constraint, or a test whose description states it (`it("…")` strings are not comments).
3. What a name cannot carry (why a choice, a constraint, a pitfall, an order that matters, a known ceiling) goes into the document of its topic: `docs/design/*.md`, `docs/testing/*`, or a rule here in `.agents/rules/`. Put it next to that topic, not into a collection file.
4. Do not write what the code already says, section dividers, task names, spec section numbers or dates anywhere.
