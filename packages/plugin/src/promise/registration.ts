export interface Registration {
  readonly dispose: () => Promise<void>
}

export interface Definitions<Editor> {
  readonly transform: (callback: (editor: Editor) => void) => Promise<Registration>
  readonly reload: () => Promise<void>
}
