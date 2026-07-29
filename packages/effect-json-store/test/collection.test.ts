import assert from "node:assert/strict";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";

import { makeJsonCollection } from "../src";
import { withTmp } from "./helpers";

const V1 = Schema.Struct({ title: Schema.String });
const V2 = Schema.Struct({ title: Schema.String, starred: Schema.Boolean });

it.effect("put/get round-trips, including nested ids", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const sessions = yield* makeJsonCollection({ dir: path.join(dir, "sessions"), schema: V2 });

      yield* sessions.put("p1/s1", { title: "hello", starred: false });
      assert.deepEqual(
        yield* sessions.get("p1/s1"),
        Option.some({ title: "hello", starred: false }),
      );

      // put replaces
      yield* sessions.put("p1/s1", { title: "hello", starred: true });
      assert.deepEqual(
        yield* sessions.get("p1/s1"),
        Option.some({ title: "hello", starred: true }),
      );
    }),
  ),
);

it.effect("get of a missing entry is none and never creates a file", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collectionDir = path.join(dir, "sessions");
      const sessions = yield* makeJsonCollection({ dir: collectionDir, schema: V2 });

      assert.deepEqual(yield* sessions.get("p1/nope"), Option.none());
      assert.equal(yield* fs.exists(path.join(collectionDir, "p1", "nope.json")), false);
    }),
  ),
);

it.effect("remove deletes an entry and is a no-op when missing", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const sessions = yield* makeJsonCollection({ dir: path.join(dir, "sessions"), schema: V2 });
      yield* sessions.put("p1/s1", { title: "x", starred: false });
      yield* sessions.remove("p1/s1");
      assert.deepEqual(yield* sessions.get("p1/s1"), Option.none());
      yield* sessions.remove("p1/s1"); // idempotent
    }),
  ),
);

it.effect("list returns entries sorted by id, supports filter, and an absent dir is empty", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const sessions = yield* makeJsonCollection({ dir: path.join(dir, "sessions"), schema: V2 });

      assert.deepEqual(yield* sessions.list(), []); // dir not created yet

      yield* sessions.put("p2/s1", { title: "b", starred: false });
      yield* sessions.put("p1/s2", { title: "a", starred: true });
      yield* sessions.put("p1/s1", { title: "c", starred: false });

      const all = yield* sessions.list();
      assert.deepEqual(
        all.map((entry) => entry.id),
        ["p1/s1", "p1/s2", "p2/s1"],
      );

      const starred = yield* sessions.list({ filter: (entry) => entry.data.starred });
      assert.deepEqual(
        starred.map((entry) => entry.id),
        ["p1/s2"],
      );
    }),
  ),
);

it.effect("get migrates an old entry and writes the new version back", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collectionDir = path.join(dir, "sessions");
      const file = path.join(collectionDir, "p1", "s1.json");
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, JSON.stringify({ version: 1, data: { title: "old" } }));

      const sessions = yield* makeJsonCollection({
        dir: collectionDir,
        schema: V2,
        migrations: [{ schema: V1, migrate: (v1) => ({ ...v1, starred: false }) }],
      });

      assert.deepEqual(yield* sessions.get("p1/s1"), Option.some({ title: "old", starred: false }));
      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, { version: 2, data: { title: "old", starred: false } });
    }),
  ),
);

it.effect("ids lists sorted entry ids without reading bodies, and skips stray filenames", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collectionDir = path.join(dir, "sessions");
      const sessions = yield* makeJsonCollection({ dir: collectionDir, schema: V2 });

      yield* sessions.put("p2/s1", { title: "b", starred: false });
      yield* sessions.put("p1/s1", { title: "a", starred: true });
      // Corrupt body and stray names: ids must not decode or die on them.
      yield* fs.writeFileString(path.join(collectionDir, "p1", "s2.json"), "{ not json");
      yield* fs.writeFileString(path.join(collectionDir, ".json"), "stray");

      assert.deepEqual(yield* sessions.ids(), ["p1/s1", "p1/s2", "p2/s1"]);
      assert.deepEqual(yield* sessions.ids({ under: "p1" }), ["p1/s1", "p1/s2"]);
    }),
  ),
);

it.effect("list scoped with `under` is unaffected by corruption in other subdirectories", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collectionDir = path.join(dir, "sessions");
      const sessions = yield* makeJsonCollection({ dir: collectionDir, schema: V2 });

      yield* sessions.put("p1/s1", { title: "a", starred: false });
      yield* fs.makeDirectory(path.join(collectionDir, "p2"), { recursive: true });
      yield* fs.writeFileString(path.join(collectionDir, "p2", "bad.json"), "{ not json");

      const scoped = yield* sessions.list({ under: "p1" });
      assert.deepEqual(
        scoped.map((entry) => entry.id),
        ["p1/s1"],
      );
      // The unscoped list still fails loudly on the corrupt entry.
      const error = yield* Effect.flip(sessions.list());
      assert.equal(error._tag, "JsonStoreParseError");
    }),
  ),
);

it.effect("a stray '.json' filename does not break list", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collectionDir = path.join(dir, "sessions");
      yield* fs.makeDirectory(collectionDir, { recursive: true });
      yield* fs.writeFileString(path.join(collectionDir, ".json"), "stray");

      const sessions = yield* makeJsonCollection({ dir: collectionDir, schema: V2 });
      assert.deepEqual(yield* sessions.list(), []);
    }),
  ),
);

it.effect("a migrating get racing a put on the same id never loses the put", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collectionDir = path.join(dir, "sessions");
      const file = path.join(collectionDir, "p1", "s1.json");
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, JSON.stringify({ version: 1, data: { title: "old" } }));

      const sessions = yield* makeJsonCollection({
        dir: collectionDir,
        schema: V2,
        migrations: [{ schema: V1, migrate: (v1) => ({ ...v1, starred: false }) }],
      });

      // Whichever order the id lock serializes them in, the migration
      // write-back must never overwrite the concurrent put.
      const fresh = { title: "fresh", starred: true };
      yield* Effect.all([sessions.get("p1/s1"), sessions.put("p1/s1", fresh)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(yield* sessions.get("p1/s1"), Option.some(fresh));
    }),
  ),
);

it.effect("a corrupt entry fails get and list loudly", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collectionDir = path.join(dir, "sessions");
      yield* fs.makeDirectory(collectionDir, { recursive: true });
      yield* fs.writeFileString(path.join(collectionDir, "bad.json"), "{ not json");

      const sessions = yield* makeJsonCollection({ dir: collectionDir, schema: V2 });

      const getError = yield* Effect.flip(sessions.get("bad"));
      assert.equal(getError._tag, "JsonStoreParseError");
      const listError = yield* Effect.flip(sessions.list());
      assert.equal(listError._tag, "JsonStoreParseError");
    }),
  ),
);
