import { useCallback, useEffect, useRef, useState } from "react";

type UseControllableStateParams<T> = {
  prop?: T;
  defaultProp?: T;
  onChange?: (value: T) => void;
};

function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: UseControllableStateParams<T>): [
  T | undefined,
  (value: T | ((prev: T | undefined) => T)) => void,
] {
  const [uncontrolledValue, setUncontrolledValue] = useState<T | undefined>(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? prop : uncontrolledValue;
  const onChangeRef = useRef(onChange);

  // Synced after commit rather than during render: `setValue` only ever fires
  // from events and effects, so it always reads the latest callback.
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const setValue = useCallback(
    (nextValue: T | ((prev: T | undefined) => T)) => {
      const currentValue = isControlled ? prop : uncontrolledValue;
      const setter = nextValue as (prev: T | undefined) => T;
      const newValue = typeof nextValue === "function" ? setter(currentValue) : nextValue;

      if (!isControlled) {
        setUncontrolledValue(newValue);
      }

      onChangeRef.current?.(newValue);
    },
    [isControlled, prop, uncontrolledValue],
  );

  return [value, setValue];
}

export { useControllableState };
