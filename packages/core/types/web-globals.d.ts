declare var TextEncoder: {
  new (): {
    encode(input?: string): Uint8Array
    encodeInto(source: string, destination: Uint8Array): { read: number; written: number }
  }
}
declare function structuredClone<T>(value: T): T
declare var URL: {
  new (url: string): { readonly protocol: string; readonly hostname: string; readonly pathname: string }
}
