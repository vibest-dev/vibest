import { Editor, type Extensions } from "@tiptap/react";

import { getChatText } from "./serialize";

export interface ChatInputControllerOptions {
  /** Factory receives self so it can close () => self.submit() into keymap extensions. */
  extensions: (self: ChatInputController) => Extensions;
  /**
   * Host business logic (chat.prompt / enqueue / …). Returning false means the
   * submit was not consumed (host is not accepting right now) — content stays.
   */
  onSubmit: (text: string) => void | boolean | Promise<void | boolean>;
}

// React-free, session-agnostic input editor facade: owns the editor lifecycle,
// the imperative API, serialization, and submit. Session state (streaming,
// suggestions) never enters here.
export class ChatInputController {
  readonly editor: Editor;
  #submitting = false;

  constructor(private readonly opts: ChatInputControllerOptions) {
    this.editor = new Editor({ extensions: opts.extensions(this) });
  }

  focus() {
    this.editor.commands.focus("end");
  }

  clear() {
    this.editor.commands.clearContent();
  }

  getText() {
    return getChatText(this.editor);
  }

  async submit() {
    if (this.#submitting) return;
    const text = this.getText();
    if (!text.trim()) return;
    this.#submitting = true;
    try {
      const consumed = await this.opts.onSubmit(text);
      if (consumed !== false) this.clear();
    } finally {
      this.#submitting = false;
    }
  }

  dispose() {
    this.editor.destroy();
  }
}
