import { useEffect, useState } from "react";

// Returns a copy of `value` that only updates once `value` has stopped
// changing for `delay` milliseconds. Used to avoid firing a request on every
// keystroke while the user types into a search box.
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
