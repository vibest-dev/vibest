import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, harnesses, Skip, until, type World } from "../world.ts"
import { addCursorPlugin } from "../world/plugins.ts"

const HARNESSES = ["claude", "pi"] as const
type Listed = { harness: string; binary: string; available: boolean; error: string | null }
type Models = { models: Array<{ harness: string; model: string }>; errors?: Array<string> }

const listed = (w: World) => w.json<Array<Listed>>(["harness", "list"], { timeoutMs: 120_000 })

const checks: ReadonlyArray<Check> = [
  {
    id: "H4",
    title: "Cursor discovery and daemon subscriptions never spawn with a temporary macOS HOME",
    run: async (w) => {
      if (process.platform !== "darwin") throw new Skip("macOS keychain safety")
      const home = path.join(w.root, "cursor-home")
      const bin = path.join(w.root, "cursor-bin")
      const marker = path.join(w.root, "cursor-started")
      await fs.mkdir(path.join(home, "Library", "Keychains"), { recursive: true })
      await fs.mkdir(bin)
      const node = Bun.which("node")
      if (node) await fs.symlink(await fs.realpath(node), path.join(bin, "node"))
      await fs.writeFile(path.join(bin, "cursor-agent"), `#!/bin/sh\nprintf started > "${marker}"\nexit 99\n`, {
        mode: 0o700,
      })
      const env = {
        HOME: home,
        PATH: bin + ":/usr/bin:/bin",
        SSH_CLIENT: "e2e",
        SSH_CONNECTION: "e2e",
        SSH_TTY: "e2e",
        SSH2_CLIENT: "e2e",
        SSH2_TTY: "e2e",
      }
      const ssh = await w.run(
        home,
        ["sh", "-c", 'test -z "${SSH_CLIENT}${SSH_CONNECTION}${SSH_TTY}${SSH2_CLIENT}${SSH2_TTY}"'],
        { env },
      )
      expect(ssh.code === 0, "temporary HOME inherited SSH session variables")
      await w.stopDaemon()
      await addCursorPlugin(w, harnesses)
      try {
        const plugins = await w.json<Array<{ id: string; status: string }>>(["plugins"], { env })
        expect(
          plugins.some((p) => p.id === "harness-cursor" && p.status === "active"),
          JSON.stringify(plugins),
        )
        const models = await w.json<Models>(["harness", "models", "cursor"], { env })
        expect(
          models.models.length === 0 && !!models.errors?.[0]?.includes("Library/Keychains"),
          JSON.stringify(models),
        )
        const subscriptions = await w.json<Array<{ harness: string; error?: string }>>(["subscriptions"], { env })
        expect(
          subscriptions.some((s) => s.harness === "cursor" && s.error?.includes("Library/Keychains")),
          JSON.stringify(subscriptions),
        )
        const refused = await w.run(w.repository, [path.join(bin, "cursor-agent"), "--version"], { env }).then(
          () => "",
          (error) => String(error),
        )
        expect(refused.includes("Refusing to start Cursor"), refused)
        expect(!(await Bun.file(marker).exists()), "Cursor started with an empty Library/Keychains directory")
      } finally {
        await w.stopDaemon()
      }
    },
  },
  {
    id: "H8",
    title:
      "Cursor is not built in: `vibest run cursor` from the entry session is refused saying no plugin provides it and how to add one; adding the shipped harnesses/cursor/plugin.js to vibest.json makes `cursor` appear in `harness list`",
    run: async (w) => {
      await w.entry()
      const before = await w.viaEntry(["run", "cursor", "--", "hello"], { timeoutMs: 60_000 })
      expect(
        before.code !== 0 && /no plugin provides harness cursor/.test(before.stderr + before.stdout),
        `${before.code} ${before.stderr}${before.stdout}`,
      )
      expect(
        /plugins.*vibest\.json/.test(before.stderr + before.stdout),
        "the refusal does not say how to add a plugin",
      )
      expect(!(await listed(w)).some((e) => e.harness === "cursor"), "cursor listed without its plugin")
      await addCursorPlugin(w, harnesses)
      await until("cursor listed", async () => (await listed(w)).some((e) => e.harness === "cursor"), 60_000)
    },
  },
  {
    id: "H1",
    covers: ["H2", "H3"],
    title:
      "H1 harness list (from vibestd): one entry per harness, a missing CLI says so; H2 harness models: a non-empty list for each installed harness; H3 doctor: grouped, one line per harness for vibest (binary, plugin, models) and one for herdr seeing its state, then a verdict",
    run: async (w) => {
      const all = await listed(w)
      expect(
        HARNESSES.every((h) => all.some((e) => e.harness === h)) && all.length === HARNESSES.length,
        `entries: ${JSON.stringify(all)}`,
      )
      for (const e of all) {
        const onPath = Bun.which(e.binary) !== null
        expect(!e.available || onPath, `${e.harness}: available but not on PATH`)
        expect(e.available === (e.error === null), `${e.harness}: available ${e.available}, error ${e.error}`)
        if (!onPath) expect(!!e.error?.includes("not on PATH"), `${e.harness}: missing without saying why`)
      }
      const installed = all.filter((e) => e.available).map((e) => e.harness)
      expect(installed.length > 0, "H2: no harness CLI on PATH")
      for (const h of installed) {
        const r = await w.json<Models>(["harness", "models", h], { timeoutMs: 120_000, unlogged: true })
        expect(
          r.models.length > 0 && r.models.every((m) => m.harness === h),
          `${h}: ${r.models.length} models, errors ${JSON.stringify(r.errors ?? [])}`,
        )
      }
      const out = await w.ok(["doctor"], { timeoutMs: 120_000 })
      for (const h of HARNESSES) {
        expect(new RegExp(`^  [✓✗] ${h} +\\d+ models|^  ✗ ${h} `, "m").test(out), `no agent line for ${h}:\n${out}`)
        const vibestCanStartIt = new RegExp(`^  ✓ ${h} +\\d+ models`, "m").test(out)
        if (vibestCanStartIt)
          expect(
            new RegExp(`^  [✓✗] ${h} +herdr can(not)? see its state`, "m").test(out),
            `no herdr line for ${h}:\n${out}`,
          )
      }
      expect(
        /^Runtime: herdr .*\(where agents run\)$/m.test(out) &&
          /^(Ready\.|\d+ problems?; run the fix lines above\.)$/m.test(out),
        `no herdr runtime section or verdict:\n${out}`,
      )
    },
  },
]

export default checks
