// Address-bar input handling, modelled on Chrome's omnibox heuristics.

const SCHEME_RE = /^(https?|file|about|data|view-source|indus):/i;
const LOCALHOST_RE = /^localhost(:\d+)?([/?#].*)?$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#].*)?$/;
const DOMAIN_RE = /^[^\s/?#:]+\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i;

export const SEARCH_ENGINES: Record<SearchEngine, { name: string; url: string }> = {
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=" },
};

// The user's chosen engine (Settings). App keeps this in sync with main.
let searchEngine: SearchEngine = "google";

export function setSearchEngine(engine: SearchEngine) {
  if (engine in SEARCH_ENGINES) searchEngine = engine;
}

export function searchEngineName() {
  return SEARCH_ENGINES[searchEngine].name;
}

/** "Google Search", "Brave Search", ... for suggestion rows. */
export function searchEngineLabel() {
  const name = searchEngineName();
  return name.endsWith("Search") ? name : `${name} Search`;
}

export function webSearchUrl(query: string) {
  return SEARCH_ENGINES[searchEngine].url + encodeURIComponent(query);
}

/** True when the text should be treated as an address rather than a search. */
export function looksLikeUrl(input: string): boolean {
  const text = input.trim();
  if (!text || /\s/.test(text)) return false;
  return SCHEME_RE.test(text) || LOCALHOST_RE.test(text) || IPV4_RE.test(text) || DOMAIN_RE.test(text);
}

/** Turns whatever was typed in the address bar into a URL to load. */
export function toNavigableUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (SCHEME_RE.test(text) && !/\s/.test(text)) return text;
  if (LOCALHOST_RE.test(text) || IPV4_RE.test(text)) return `http://${text}`;
  if (DOMAIN_RE.test(text)) return `https://${text}`;
  return webSearchUrl(text);
}

/** Chrome-style elided URL for display while the address bar isn't focused. */
export function formatDisplayUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  const stripped = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  return stripped.endsWith("/") && stripped.indexOf("/") === stripped.length - 1
    ? stripped.slice(0, -1)
    : stripped;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Rough registrable domain ("www.bbc.co.uk" -> "bbc.co.uk") for grouping cookies. */
export function siteOf(host: string): string {
  const clean = host.replace(/^\./, "").toLowerCase();
  if (IPV4_RE.test(clean) || !clean.includes(".")) return clean;
  const labels = clean.split(".");
  if (labels.length <= 2) return clean;
  const secondLevel = labels[labels.length - 2];
  const takeThree = secondLevel.length <= 3 && labels[labels.length - 1].length === 2;
  return labels.slice(takeThree ? -3 : -2).join(".");
}

export function faviconFor(host: string) {
  return `https://www.google.com/s2/favicons?sz=64&domain=${host}`;
}
