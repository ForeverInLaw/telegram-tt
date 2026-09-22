/** jsdom lacks `matchMedia`; the app's window-environment module reads it at import time. */
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: undefined,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom exposes no `CSS` global; the window-environment module probes `CSS.supports` at import time.
if (typeof globalThis.CSS === 'undefined') {
  (globalThis as Record<string, unknown>).CSS = { supports: () => false };
} else if (!CSS.supports) {
  Object.defineProperty(CSS, 'supports', {
    configurable: true,
    writable: true,
    value: () => false,
  });
}

export {};
