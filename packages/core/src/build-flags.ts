export const NO_AUTOLOAD = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv"] as const

export const buildArgs = (outfile: string) => [
  "build",
  "--compile",
  "./src/main.ts",
  "--outfile",
  outfile,
  ...NO_AUTOLOAD,
]
