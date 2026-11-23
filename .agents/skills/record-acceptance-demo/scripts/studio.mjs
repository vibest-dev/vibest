import fs from "node:fs/promises"
import path from "node:path"

const RENDERER_PACKAGES = ["@wterm/dom@0.6.0", "@xterm/xterm@6", "@xterm/addon-unicode11@0.9", "playwright@1.65.1"]
const WIDTH = 1920
const HEIGHT = 1080
const HEADROOM_MS = Number(Bun.env.STUDIO_TIMEOUT_MS ?? 120_000)

const [tapePath, outDir, slug, renderer = "wterm"] = Bun.argv.slice(2)

if (!tapePath || !outDir || !slug || !["wterm", "xterm"].includes(renderer)) {
  console.error("usage: bun studio.mjs <tape.json> <out-dir> <slug> [wterm|xterm]")
  process.exit(2)
}

const workDir = Bun.env.STUDIO_WORK ?? "/tmp/vbstudio-work"

const run = async (argv, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" })

  if ((await proc.exited) !== 0) throw new Error(`studio: ${argv.join(" ")} failed`)
}

await fs.mkdir(workDir, { recursive: true })

await fs.mkdir(outDir, { recursive: true })

if (!(await Bun.file(path.join(workDir, "node_modules/playwright/package.json")).exists())) {
  await Bun.write(path.join(workDir, "package.json"), '{ "private": true }')
  await run(["npm", "install", "--silent", "--no-audit", "--no-fund", ...RENDERER_PACKAGES], workDir)
}

await run(["npx", "playwright", "install", "chromium-headless-shell"], workDir)

const { chromium } = await import(path.join(workDir, "node_modules/playwright/index.mjs"))
const tape = await Bun.file(tapePath).json()
const playerPath = path.join(import.meta.dir, "player.html")

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url)

    if (pathname === "/") return new Response(Bun.file(playerPath))

    if (pathname === "/tape.json") return Response.json(tape)
    const local = path.join(workDir, path.normalize(pathname))

    if (pathname.startsWith("/node_modules/") && local.startsWith(workDir)) return new Response(Bun.file(local))

    return new Response("not found", { status: 404 })
  },
})

const videoDir = await fs.mkdtemp("/tmp/vbstudio-video-")
const browser = await chromium.launch()
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

  await page.goto(`http://127.0.0.1:${server.port}/?renderer=${renderer}`)
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
  console.log(JSON.stringify({ mp4, keyframes }, null, 2))
} finally {
  await browser.close()
  server.stop(true)
  await fs.rm(videoDir, { recursive: true, force: true })
}
