import { until } from "../world.ts"

const startupDialog = /trust this folder|Adding a new directory/i
const acceptSelected = /^\s*❯.*(?:Yes, I trust this folder|Yes, add it)/im

export const answerFolderTrust = async (
  screen: () => Promise<string>,
  press: (key: "enter" | "down") => Promise<unknown>,
  timeoutMs = 60_000,
) => {
  await until(
    "Claude's trust question or its input box",
    async () => startupDialog.test(await screen()) || /❯\s*$/im.test(await screen()),
    timeoutMs,
  )
  for (let i = 0; i < 20 && startupDialog.test(await screen()); i++) {
    await press(acceptSelected.test(await screen()) ? "enter" : "down")
    await Bun.sleep(1_000)
  }
}

const squeeze = (s: string) => s.replace(/\s+/g, "")

export const typeAndEnter = async (
  screen: () => Promise<string>,
  send: { readonly text: (text: string) => Promise<unknown>; readonly enter: () => Promise<unknown> },
  text: string,
  timeoutMs = 30_000,
) => {
  await send.text(text)
  const aBusyClaudeTakesTextAndAQuickEnterAsOnePasteAndSendsNothing = `"${text}" in the input line`
  await until(
    aBusyClaudeTakesTextAndAQuickEnterAsOnePasteAndSendsNothing,
    async () => {
      const s = await screen()
      return squeeze(s.slice(s.lastIndexOf("❯"))).includes(squeeze(text))
    },
    timeoutMs,
  ).catch(async (e: Error) => {
    throw new Error(`${e.message}; its screen:\n${await screen()}`)
  })
  await send.enter()
}
