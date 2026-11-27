import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import url from "node:url"

const MODULE_DIR = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(MODULE_DIR, "..")

export async function buildClientAssets(): Promise<string> {
  const distDir = path.join(ROOT_DIR, "dist")
  fs.mkdirSync(distDir, { recursive: true })

  const entryPoint = path.join(MODULE_DIR, "client", "main.ts")

  const buildResult = await Bun.build({
    entrypoints: [entryPoint],
    outdir: distDir,
    target: "browser",
    format: "esm",
    splitting: true,
    sourcemap: "linked",
    naming: {
      entry: "app.js",
      chunk: "chunk-[name]-[hash].[ext]",
      asset: "asset-[name]-[hash].[ext]",
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  })

  if (!buildResult.success) {
    const messages = buildResult.logs.map((log) => log.message).join("\n")
    throw new Error(`Client bundle failed:\n${messages}`)
  }

  const wtermCssSrc = path.join(ROOT_DIR, "node_modules", "@wterm", "dom", "src", "terminal.css")

  if (fs.existsSync(wtermCssSrc)) {
    fs.copyFileSync(wtermCssSrc, path.join(distDir, "wterm.css"))
  }

  const tailwindBin = path.join(ROOT_DIR, "node_modules", ".bin", "tailwindcss")
  const appCssSrc = path.join(MODULE_DIR, "client", "styles.css")
  const appCssOut = path.join(distDir, "styles.css")

  childProcess.execFileSync(tailwindBin, ["-i", appCssSrc, "-o", appCssOut, "--minify"], {
    cwd: ROOT_DIR,
    stdio: "pipe",
  })

  const indexHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vibest — Web Management Hub</title>
  <link rel="stylesheet" href="/wterm.css" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
`

  fs.writeFileSync(path.join(distDir, "index.html"), indexHtml, "utf8")

  return distDir
}

if (import.meta.main) {
  buildClientAssets()
    .then((dir) => {
      console.log(`Built vibest-web client assets into ${dir}`)
    })
    .catch((err: Error) => {
      console.error(err.message)
      process.exit(1)
    })
}
