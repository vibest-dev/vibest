import * as MemoryStore from "./memory-store.ts"
import { storeContract } from "./store-contract.ts"

storeContract("in memory", MemoryStore.layer)
