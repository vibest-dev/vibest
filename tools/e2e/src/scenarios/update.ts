import type { Check } from "../check.ts"
import { buildVersion, expect, method } from "../world.ts"

const checks: ReadonlyArray<Check> = [
  {
    id: "U1",
    title:
      "update reads the latest version where vibest was installed from (npm's registry or the GitHub release) and installs nothing when it is this version; a build installs nothing",
    run: async (w) => {
      await w.stopDaemon()
      const r = await w.vibest(["update"], { timeoutMs: 60_000 })
      const said = `exit ${r.code}: ${r.stdout}${r.stderr}`
      if (method === "build")
        expect(r.code === 0 && /was not installed by npm or install\.sh; nothing to install/.test(r.stdout), said)
      else expect(r.code === 0 && r.stdout.includes(`vibest is already up to date (v${buildVersion})`), said)
      const version = await w.ok(["--version"])
      expect(version.trim() === `vibest v${buildVersion}`, `vibest --version after update: ${version}`)
    },
  },
]

export default checks
