import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "status_prompt",
    label: "Scratch confirmation",
    description: "Ask the person to confirm the scratch terminal test",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_id, _args, signal, _update, ctx) => ({
      content: [
        {
          type: "text",
          text: String(await ctx.ui.confirm("Confirm the scratch test", "This performs no action", { signal })),
        },
      ],
      details: {},
    }),
  })
  pi.registerCommand("status-input", {
    handler: async (_args, ctx) => {
      await ctx.ui.input("Scratch input")
    },
  })
}
