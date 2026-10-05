// Address-bar input handling, modelled on Chrome's omnibox heuristics.

const SCHEME_RE = /^(https?|file|about|data|view-source|indus):/i;
const LOCALHOST_RE = /^localhost(:\d+)?([/?#].*)?$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#].*)?$/;
const DOMAIN_RE = /^[^\s/?#:]+\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i;

export function googleSearchUrl(query: string) {
  return "https://www.google.com/search?q=" + encodeURIComponent(query);
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
  return googleSearchUrl(text);
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
