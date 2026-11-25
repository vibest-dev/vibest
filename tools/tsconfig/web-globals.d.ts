declare var TextEncoder: {
  new (): {
    encode(input?: string): Uint8Array
    encodeInto(source: string, destination: Uint8Array): { read: number; written: number }
  }
}

declare function queueMicrotask(callback: () => void): void

declare function structuredClone<T>(value: T): T

interface URL {
  readonly protocol: string
  readonly hostname: string
  readonly pathname: string
  readonly search: string
}

declare var URL: {
  new (url: string): URL
}
