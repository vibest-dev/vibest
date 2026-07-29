/**
 * Effect-native JSON file storage with schema validation and integer-versioned
 * migrations (a flat `migrations` array, one schema and one `migrate()` per
 * superseded version, current version persisted in each file).
 *
 * Two shapes share one engine:
 * - `makeJsonDocument` — a standalone file: seeded defaults, eager load, cache.
 * - `makeJsonCollection` — a directory of keyed entries: get/put/remove/list.
 */
export type { AnySchema, MigrationStep } from "./codec";
export {
  type JsonCollection,
  type JsonCollectionEntry,
  type JsonCollectionListOptions,
  type JsonCollectionOptions,
  makeJsonCollection,
} from "./collection";
export { type JsonDocument, type JsonDocumentOptions, makeJsonDocument } from "./document";
export * from "./errors";
export type { KeyPath, KeyPathValue } from "./path";
