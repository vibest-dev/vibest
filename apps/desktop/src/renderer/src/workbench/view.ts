import type { Part } from "./part";

export abstract class View {
  part!: Part;

  abstract getViewType(): string;
  abstract getDisplayText(): string;

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}

  getState(): unknown {
    return {};
  }

  async setState(_state: unknown): Promise<void> {}
}
