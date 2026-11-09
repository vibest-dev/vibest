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
