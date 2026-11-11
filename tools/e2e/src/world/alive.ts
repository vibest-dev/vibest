export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const state = Bun.spawnSync(["ps", "-p", String(pid), "-o", "state="])
    .stdout.toString()
    .trim()
  return state !== "" && !state.startsWith("Z")
}
