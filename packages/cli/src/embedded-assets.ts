import { materializeAssets } from "./assets-archive.ts"
import { VERSION } from "./version.ts"

export const loadEmbeddedAssets = (): Uint8Array | undefined => undefined

export const materializeEmbedded = (home: string) => {
  const archive = loadEmbeddedAssets()

  return archive === undefined ? undefined : materializeAssets(home, VERSION, archive)
}
