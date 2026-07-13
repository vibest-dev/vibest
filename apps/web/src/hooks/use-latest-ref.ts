import { useInsertionEffect, useRef } from "react";

// Write in an insertion effect so render stays pure (React can replay or
// discard renders). Readers only dereference from event handlers/effects,
// which always run after the write.
export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}
