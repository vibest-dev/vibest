import fs from "node:fs/promises"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

const ANSI_PATTERN = new RegExp(
  [`${ESC}\\[[0-?]*[ -/]*[@-~]`, `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, `${ESC}[@-Z\\\\-_]`].join("|"),
  "g",
)

export const COLS = 132
export const ROWS = 36

export const stripAnsi = (text) => text.replace(ANSI_PATTERN, "").replaceAll("\r", "")

export function openTape(argv, env, cwd) {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const events = []
  const decoder = new TextDecoder()
  const output = { raw: "", searchFrom: 0 }

  const proc = Bun.spawn(argv, {
    cwd,
    env,
    terminal: {
      cols: COLS,
      rows: ROWS,
      data(_terminal, bytes) {
        const data = decoder.decode(bytes, { stream: true })
        output.raw += data
        events.push({ at: elapsed(), kind: "out", data })
      },
    },
  })

  const text = () => stripAnsi(output.raw)

  async function wait(pattern, timeoutMs = 15_000) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(RegExp.escape(pattern))

    const found = () => {
      const match = text().slice(output.searchFrom).search(regex)

      if (match >= 0) output.searchFrom += match + 1

      return match >= 0
    }

    const deadline = performance.now() + timeoutMs

    while (performance.now() < deadline && proc.exitCode === null) {
      if (found()) return
      await Bun.sleep(50)
    }

    await Bun.sleep(200)

    if (found()) return
    throw new Error(
      `pty-tape: ${String(pattern)} not seen within ${timeoutMs} ms; last output:\n${text().slice(-2000)}`,
    )
  }

  async function type(input, delayMs = 45) {
    for (const char of input) {
      proc.terminal.write(char)
      await Bun.sleep(delayMs)
    }
  }

  const mark = (kind, fields) => events.push({ at: elapsed(), kind, ...fields })

  return {
    proc,
    text,
    wait,
    type,
    press: (keys) => proc.terminal.write(keys),
    pause: (ms) => Bun.sleep(ms),
    step: (scene, caption) => mark("step", { scene, caption }),
    state: (title, body) => mark("state", { title, body }),
    keyframe: (name) => mark("keyframe", { name }),
    async close() {
      if (proc.exitCode === null) proc.kill("SIGHUP")
      await Promise.race([proc.exited, Bun.sleep(3000).then(() => proc.kill("SIGKILL"))])
      await proc.exited
      proc.terminal.close()
    },
    async save(path, title) {
      await fs.writeFile(path, JSON.stringify({ title, cols: COLS, rows: ROWS, duration: elapsed(), events }, null, 2))
      await fs.writeFile(path.replace(/\.json$/, ".txt"), text())
    },
  }
}

if (import.meta.main) {
  const [path, separator, ...argv] = Bun.argv.slice(2)

  if (!path || separator !== "--" || argv.length === 0) {
    console.error("usage: bun pty-tape.mjs <tape.json> -- <command> [args...]")
    process.exit(2)
  }

  const command = [argv[0].split("/").at(-1), ...argv.slice(1)].join(" ")
  const tape = openTape(argv, Bun.env, process.cwd())
  tape.step("1/1", command)
  const code = await tape.proc.exited
  await tape.pause(300)
  tape.keyframe("final")
  await tape.close()
  await tape.save(path, command)
  console.log(`tape ${path} (exit ${code})`)
}
