import fs from "node:fs/promises"
import path from "node:path"

const PACKAGES = ["@wterm/dom@0.6.0", "playwright@1.65.1"]
const WIDTH = 1920
const HEIGHT = 1080
const HEADROOM_MS = Number(Bun.env.STUDIO_TIMEOUT_MS ?? 120_000)

const [tapePath, outDir, slug] = Bun.argv.slice(2)

if (!tapePath || !outDir || !slug) {
  console.error("usage: bun studio.mjs <tape.json> <out-dir> <slug>")
  process.exit(2)
}

const workDir = path.resolve(Bun.env.STUDIO_WORK ?? "/tmp/vbstudio-work")
const nodeModules = path.join(workDir, "node_modules")

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(workDir, "ms-playwright")

const run = async (argv, cwd) => {
  const proc = Bun.spawn(argv, { cwd, env: { ...process.env }, stdout: "inherit", stderr: "inherit" })

  if ((await proc.exited) !== 0) throw new Error(`studio: ${argv.join(" ")} failed`)
}

async function installPackages() {
  const stamp = Bun.file(path.join(workDir, "studio-packages.txt"))
  const wanted = PACKAGES.join("\n")

  if ((await stamp.exists()) && (await stamp.text()) === wanted) return
  await fs.rm(nodeModules, { recursive: true, force: true })
  await Bun.write(path.join(workDir, "package.json"), '{ "private": true }')
  await run(["npm", "install", "--silent", "--no-audit", "--no-fund", "--save-exact", ...PACKAGES], workDir)
  await Bun.write(stamp, wanted)
}

async function serveModule(pathname) {
  const local = path.resolve(nodeModules, `.${pathname.slice("/node_modules".length)}`)
  const file = Bun.file(local)

  if (!local.startsWith(nodeModules + path.sep) || !(await file.exists())) return undefined

  return new Response(file)
}

async function record(tape, server, chromium) {
  const browser = await chromium.launch()
  const videoDir = await fs.mkdtemp("/tmp/vbstudio-video-")
  const keyframes = []

  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      recordVideo: { dir: videoDir, size: { width: WIDTH, height: HEIGHT } },
    })

    const page = await context.newPage()
    const finished = Promise.withResolvers()
    page.on("pageerror", (error) => finished.reject(new Error(`studio page error: ${error.message}`)))
    page.on("console", (message) => {
      if (message.type() === "error") finished.reject(new Error(`studio console error: ${message.text()}`))
    })
    await page.exposeFunction("studioKeyframe", async (name) => {
      const file = path.join(outDir, `${slug}-${keyframes.length + 1}-${name}.png`)
      await page.screenshot({ path: file })
      keyframes.push(file)
    })
    await page.exposeFunction("studioDone", () => finished.resolve())

    const timeout = setTimeout(
      () => finished.reject(new Error(`studio: playback did not finish within ${tape.duration + HEADROOM_MS} ms`)),
      tape.duration + HEADROOM_MS,
    )

    await page.goto(`http://127.0.0.1:${server.port}/`)
    await finished.promise.finally(() => clearTimeout(timeout))
    await context.close()
    const webm = await page.video().path()
    const mp4 = path.join(outDir, `${slug}-demo.mp4`)
    await run(
      [
        "ffmpeg",
        "-loglevel",
        "error",
        "-y",
        "-i",
        webm,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "slow",
        "-crf",
        "20",
        "-movflags",
        "+faststart",
        mp4,
      ],
      outDir,
    )

    return { mp4, keyframes }
  } finally {
    await browser.close()
    await fs.rm(videoDir, { recursive: true, force: true })
  }
}

async function main() {
  await fs.mkdir(workDir, { recursive: true })
  await fs.mkdir(outDir, { recursive: true })
  await installPackages()
  await run(["npx", "playwright", "install", "chromium-headless-shell"], workDir)

  const { chromium } = await import(path.join(nodeModules, "playwright/index.mjs"))
  const tape = await Bun.file(tapePath).json()
  const playerPath = path.join(import.meta.dir, "player.html")

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url)

      if (pathname === "/") return new Response(Bun.file(playerPath))

      if (pathname === "/tape.json") return Response.json(tape)

      if (pathname.startsWith("/node_modules/")) {
        const response = await serveModule(pathname)

        if (response) return response
      }

      return new Response("not found", { status: 404 })
    },
  })

  try {
    console.log(JSON.stringify(await record(tape, server, chromium), null, 2))
  } finally {
    server.stop(true)
  }
}

await main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
