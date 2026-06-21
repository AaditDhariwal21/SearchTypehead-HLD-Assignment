import { useEffect, useState } from 'react';

// Returns a copy of `value` that only updates after `delayMs` of no further
// changes. WHY: typing fires on every keystroke; without debouncing we'd issue a
// /suggest request per character. Debouncing to 300ms means we only query once
// the user briefly pauses — far fewer backend hits, and 300ms is the usual
// sweet spot (fast enough to feel live, slow enough to skip in-between keystrokes).
export function useDebounce(value, delayMs) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    // Cleanup cancels the pending timer whenever `value` changes again before it
    // fires — this is what actually collapses a burst of keystrokes into one update.
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
