import { until } from "../world.ts"

export const answerFolderTrust = async (
  screen: () => Promise<string>,
  press: (key: "enter" | "down") => Promise<unknown>,
  timeoutMs = 60_000,
) => {
  await until(
    "Claude's trust question or its input box",
    async () => /trust this folder|❯\s*$/im.test(await screen()),
    timeoutMs,
  )
  for (let i = 0; i < 10 && /trust this folder/i.test(await screen()); i++) {
    await press(/^\s*❯.*Yes, I trust this folder/im.test(await screen()) ? "enter" : "down")
    await Bun.sleep(1_000)
  }
}
