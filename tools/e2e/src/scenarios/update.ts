import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { binary, expect, method } from "../world.ts"

const checks: ReadonlyArray<Check> = [
  {
    id: "U1",
    title:
      "update installs the newer version the way vibest was installed (install.sh or npm); a build installs nothing",
    run: async (w) => {
      await w.stopDaemon()
      const log = path.join(w.root, "update.log")
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (req) => {
          const url = new URL(req.url).pathname
          if (url === "/version") return new Response("999.0.0\n")
          if (url === "/@vibest/cli/beta") return Response.json({ name: "@vibest/cli", version: "999.0.0" })
          if (url === "/install.sh")
            return new Response(
              `echo "install.sh VIBEST_INSTALL=$VIBEST_INSTALL VIBEST_DOWNLOAD_URL=$VIBEST_DOWNLOAD_URL" >> '${log}'\n`,
            )
          return new Response("not found", { status: 404 })
        },
      })
      try {
        const origin = `http://127.0.0.1:${server.port}`
        const argRecordingPmStubs = path.join(w.root, "update-bin")
        await fs.mkdir(argRecordingPmStubs, { recursive: true })
        for (const pm of ["npm", "bun"])
          await fs.writeFile(path.join(argRecordingPmStubs, pm), `#!/bin/sh\necho "${pm} $*" >> '${log}'\n`, {
            mode: 0o755,
          })
        const r = await w.vibest(["update"], {
          env: {
            VIBEST_DOWNLOAD_URL: origin,
            npm_config_registry: origin,
            PATH: `${argRecordingPmStubs}:${w.env().PATH}`,
          },
          timeoutMs: 60_000,
        })
        const ran = await fs.readFile(log, "utf8").catch(() => "")
        if (method === "build") {
          expect(
            r.code === 0 && /was not installed by npm or install\.sh; nothing to install/.test(r.stdout),
            `exit ${r.code}: ${r.stdout}${r.stderr}`,
          )
          expect(ran === "", `an installer ran: ${ran}`)
          return
        }
        expect(
          r.code === 0 && r.stdout.includes("vibest 999.0.0 is available"),
          `exit ${r.code}: ${r.stdout}${r.stderr}`,
        )
        if (method === "npm") expect(ran === "npm install -g @vibest/cli@beta\n", `ran: ${ran}`)
        else {
          const installDir = path.dirname(path.dirname(path.dirname(path.dirname(await fs.realpath(binary)))))
          expect(ran === `install.sh VIBEST_INSTALL=${installDir} VIBEST_DOWNLOAD_URL=${origin}\n`, `ran: ${ran}`)
        }
      } finally {
        await server.stop(true)
      }
    },
  },
]

export default checks
