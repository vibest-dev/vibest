declare var TextEncoder: { new (): { encode(input?: string): Uint8Array } }
declare function structuredClone<T>(value: T): T
declare var URL: {
  new (url: string): { readonly protocol: string; readonly hostname: string; readonly pathname: string }
}
