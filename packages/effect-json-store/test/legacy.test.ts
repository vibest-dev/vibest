import assert from "node:assert/strict";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";

import { makeJsonCollection, makeJsonDocument } from "../src";
import { withTmp } from "./helpers";

const V1 = Schema.Struct({ theme: Schema.String });
const V2 = Schema.Struct({ theme: Schema.String, fontSize: Schema.Number });

// Pre-envelope shape: a bare object with a differently-named field.
const LegacyShape = Schema.Struct({ colour: Schema.String });
const legacy = {
  schema: LegacyShape,
  migrate: (old: typeof LegacyShape.Type) => ({ theme: old.colour }),
};

it.effect("document adopts a pre-envelope file and writes it back in envelope form", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(file, JSON.stringify({ colour: "dark" }));

      const store = yield* makeJsonDocument({
        path: file,
        schema: V1,
        legacy,
        defaults: { theme: "light" },
      });
      assert.deepEqual(yield* store.get, { theme: "dark" });

      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, { version: 1, data: { theme: "dark" } });
    }),
  ),
);

it.effect("a legacy body carrying an integer `version` field still takes the legacy path", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      // The session-record case: the bare body has `version: 1` but no `data`
      // key, so it must miss the envelope decode and be adopted as legacy.
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(file, JSON.stringify({ version: 1, theme: "dark" }));

      const VersionedBody = Schema.Struct({ version: Schema.Literal(1), theme: Schema.String });
      const store = yield* makeJsonDocument({
        path: file,
        schema: V1,
        legacy: {
          schema: VersionedBody,
          migrate: (body) => ({ theme: body.theme }),
        },
        defaults: { theme: "light" },
      });
      assert.deepEqual(yield* store.get, { theme: "dark" });

      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, { version: 1, data: { theme: "dark" } });
    }),
  ),
);

it.effect("a legacy file runs through the whole migration chain after adoption", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(file, JSON.stringify({ colour: "dark" }));

      const store = yield* makeJsonDocument({
        path: file,
        schema: V2,
        migrations: [{ schema: V1, migrate: (v1) => ({ ...v1, fontSize: 14 }) }],
        legacy,
        defaults: { theme: "light", fontSize: 14 },
      });
      assert.deepEqual(yield* store.get, { theme: "dark", fontSize: 14 });

      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, { version: 2, data: { theme: "dark", fontSize: 14 } });
    }),
  ),
);

it.effect("a file failing the legacy schema fails with JsonStoreDecodeError version 0", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      const original = JSON.stringify({ colour: 42 });
      yield* fs.writeFileString(file, original);

      const error = yield* Effect.flip(
        makeJsonDocument({ path: file, schema: V1, legacy, defaults: { theme: "light" } }),
      );
      assert.equal(error._tag, "JsonStoreDecodeError");
      assert.equal(error._tag === "JsonStoreDecodeError" && error.version, 0);
      // A failed adoption never touches the file.
      assert.equal(yield* fs.readFileString(file), original);
    }),
  ),
);

it.effect("collection entries are adopted on first get and written back", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collectionDir = path.join(dir, "items");
      const file = path.join(collectionDir, "a.json");
      yield* fs.makeDirectory(collectionDir, { recursive: true });
      yield* fs.writeFileString(file, JSON.stringify({ colour: "red" }));

      const items = yield* makeJsonCollection({ dir: collectionDir, schema: V1, legacy });
      assert.deepEqual(yield* items.get("a"), Option.some({ theme: "red" }));

      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, { version: 1, data: { theme: "red" } });
    }),
  ),
);
