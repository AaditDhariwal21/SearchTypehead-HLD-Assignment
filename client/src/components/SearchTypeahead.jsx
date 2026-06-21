import { useEffect, useState } from 'react';
import { useDebounce } from '../hooks/useDebounce.js';
import './SearchTypeahead.css';

const DEBOUNCE_MS = 300;
// Don't query until at least this many characters are typed. WHY: 1–2 char
// prefixes match a huge slice of the dataset (low information, expensive to rank)
// and the user almost never wants results that early. Gating here means the
// backend is never even hit for those — debounce + min-length together keep
// /suggest traffic to meaningful queries only.
const MIN_QUERY_LENGTH = 3;

export default function SearchTypeahead() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  // -1 means "no suggestion highlighted" — focus is conceptually on the input.
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  // Dummy response message shown after a submission (e.g. "Searched").
  const [message, setMessage] = useState('');
  // Ranking mode: "basic" (all-time popular) or "trending" (recency-aware).
  const [mode, setMode] = useState('basic');

  const debouncedQuery = useDebounce(query, DEBOUNCE_MS);
  const trimmed = debouncedQuery.trim();

  // Fetch suggestions whenever the *debounced* query OR the mode changes
  // (switching Popular/Trending re-queries the current prefix).
  useEffect(() => {
    // Below the minimum length: no fetch, no results (the dropdown stays hidden).
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    // AbortController guards against out-of-order responses: if the user types
    // again before the previous request resolves, we abort the stale request so
    // a slow earlier response can't overwrite newer suggestions.
    const controller = new AbortController();
    setLoading(true);

    const url = `/suggest?q=${encodeURIComponent(trimmed)}&mode=${mode}`;
    fetch(url, { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        setSuggestions(Array.isArray(data) ? data : []);
        setHighlightedIndex(-1); // reset highlight on every new result set
        setLoading(false);
      })
      .catch((err) => {
        // Aborts are expected (superseded request) — ignore them. Any real
        // failure degrades gracefully to "no suggestions" rather than crashing.
        if (err.name !== 'AbortError') {
          setSuggestions([]);
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [trimmed, mode]);

  // Submit a search: POST /search, then show the server's dummy response message.
  // (Step 4 made this a real call; the count update happens server-side.)
  async function submitSearch(term) {
    if (!term) return;
    setIsOpen(false);
    setHighlightedIndex(-1);
    try {
      const res = await fetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: term }),
      });
      const data = await res.json();
      setMessage(data.message ? `${data.message}: "${term}"` : 'Search failed');
    } catch {
      setMessage('Search failed');
    }
  }

  // "Selecting" a suggestion fills the input with it and closes the dropdown.
  // Per the spec this is distinct from submission (Enter on a *highlighted*
  // suggestion selects; Enter with nothing highlighted submits). Step 4 can
  // connect selection to submission if we want that UX.
  function selectSuggestion(s) {
    setQuery(s.term);
    setIsOpen(false);
    setHighlightedIndex(-1);
  }

  function onChange(e) {
    setQuery(e.target.value);
    setIsOpen(true);
  }

  function onKeyDown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault(); // stop the caret from jumping to end of input
        if (!isOpen) {
          setIsOpen(true);
          return;
        }
        setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        // Going above the first item returns to the input (-1 = no highlight).
        setHighlightedIndex((i) => Math.max(i - 1, -1));
        break;
      case 'Enter':
        if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
          selectSuggestion(suggestions[highlightedIndex]);
        } else {
          // Enter on the input itself, nothing highlighted -> submit what's typed.
          submitSearch(query.trim());
        }
        break;
      case 'Escape':
        setIsOpen(false);
        setHighlightedIndex(-1);
        break;
      default:
        break;
    }
  }

  // Only show the dropdown once the prefix is long enough to have queried.
  const showDropdown = isOpen && trimmed.length >= MIN_QUERY_LENGTH;

  return (
    <div className="typeahead">
      <div className="typeahead__modes" role="group" aria-label="Ranking mode">
        {['basic', 'trending'].map((m) => (
          <button
            key={m}
            type="button"
            className={'typeahead__mode' + (mode === m ? ' typeahead__mode--active' : '')}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
          >
            {m === 'basic' ? 'Popular' : 'Trending'}
          </button>
        ))}
      </div>

      <div className="typeahead__row">
        <input
          type="text"
          className="typeahead__input"
          placeholder="Search…"
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => query.trim() && setIsOpen(true)}
          // Close on blur, but let suggestion clicks land first (see onMouseDown below).
          onBlur={() => setIsOpen(false)}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="typeahead-listbox"
          aria-activedescendant={
            highlightedIndex >= 0 ? `typeahead-option-${highlightedIndex}` : undefined
          }
          autoComplete="off"
        />
        <button
          type="button"
          className="typeahead__button"
          onClick={() => submitSearch(query.trim())}
        >
          Search
        </button>
      </div>

      {showDropdown && (
        <div
          className="typeahead__dropdown"
          // preventDefault on mousedown stops the input from blurring before the
          // click's onClick runs, so clicking a suggestion actually selects it.
          onMouseDown={(e) => e.preventDefault()}
        >
          {loading ? (
            <div className="typeahead__status">Loading…</div>
          ) : suggestions.length === 0 ? (
            <div className="typeahead__status">No matches</div>
          ) : (
            <ul className="typeahead__list" id="typeahead-listbox" role="listbox">
              {suggestions.map((s, i) => (
                <li
                  key={s.term + i}
                  id={`typeahead-option-${i}`}
                  role="option"
                  aria-selected={i === highlightedIndex}
                  className={
                    'typeahead__item' +
                    (i === highlightedIndex ? ' typeahead__item--active' : '')
                  }
                  onMouseEnter={() => setHighlightedIndex(i)}
                  onClick={() => selectSuggestion(s)}
                >
                  <span className="typeahead__term">{s.term}</span>
                  <span className="typeahead__count">{s.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {message && <p className="typeahead__message">{message}</p>}
    </div>
  );
}
