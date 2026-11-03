// `vibest update` updates vibest the way it was installed: install.sh runs again from the release into the same
// directories, npm reinstalls @vibest/cli, and a build has nothing to install (the steps after it still run). A local server stands in for the GitHub release
// and the npm registry, offering a newer version; the installers it hands out only record how they were run.
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
      // A running vibestd would be offered for replacement, which needs a terminal: this check is about the install.
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
        // npm and bun that only record their arguments, first on PATH.
        const stubs = path.join(w.root, "update-bin")
        await fs.mkdir(stubs, { recursive: true })
        for (const pm of ["npm", "bun"])
          await fs.writeFile(path.join(stubs, pm), `#!/bin/sh\necho "${pm} $*" >> '${log}'\n`, { mode: 0o755 })
        const r = await w.vibest(["update"], {
          env: { VIBEST_DOWNLOAD_URL: origin, npm_config_registry: origin, PATH: `${stubs}:${w.env().PATH}` },
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
          // The release's install.sh, into the directory this vibest was installed in (the link resolved).
          const share = path.dirname(path.dirname(path.dirname(path.dirname(await fs.realpath(binary)))))
          expect(ran === `install.sh VIBEST_INSTALL=${share} VIBEST_DOWNLOAD_URL=${origin}\n`, `ran: ${ran}`)
        }
      } finally {
        await server.stop(true)
      }
    },
  },
]

export default checks
