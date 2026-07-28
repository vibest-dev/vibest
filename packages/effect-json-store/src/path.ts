/**
 * Typed dot-notation paths. Traversal recurses through required plain objects
 * only: primitives, arrays, and optional fields are leaves (an optional object
 * is read/written as a whole at its own key), so a path can never hit
 * `undefined` mid-way at runtime.
 */
type Leaf =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | ReadonlyArray<unknown>
  | ((...args: never) => unknown);

/** All dot-notation paths of `T`, e.g. `"appearance" | "appearance.fontSize"`. */
export type KeyPath<T> = T extends Leaf
  ? never
  : {
      [K in keyof T & string]: [NonNullable<T[K]>] extends [Leaf]
        ? K
        : undefined extends T[K]
          ? K
          : K | `${K}.${KeyPath<T[K]>}`;
    }[keyof T & string];

/** The value type at path `P` in `T`. */
export type KeyPathValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? KeyPathValue<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/** @internal Runtime walk; the path is compile-time validated, so no guards. */
export const getAtPath = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], value);

/** @internal Immutably rebuild the spine along `segments`, replacing the leaf. */
export const setAtPath = (
  value: unknown,
  segments: ReadonlyArray<string>,
  leaf: unknown,
): unknown => {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return leaf;
  }
  const record = value as Record<string, unknown>;
  return { ...record, [head]: setAtPath(record[head], rest, leaf) };
};
