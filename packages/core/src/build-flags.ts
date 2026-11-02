// How the vibest binary is built (scripts/build.ts).
// A compiled Bun executable loads bunfig.toml (whose `preload` runs code) and .env from the directory it runs in unless
// it was built with these flags; vibest runs in repositories it does not control.

/** Flags the production build always passes. */
export const NO_AUTOLOAD = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv"] as const

/** `bun build` arguments of the production binary. */
export const buildArgs = (outfile: string) => [
  "build",
  "--compile",
  "./src/main.ts",
  "--outfile",
  outfile,
  ...NO_AUTOLOAD,
]
