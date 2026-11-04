import * as MemoryStorage from "./memory-storage.ts"
import { storageConformance } from "./storage-conformance.ts"

storageConformance("in memory", MemoryStorage.layer)
