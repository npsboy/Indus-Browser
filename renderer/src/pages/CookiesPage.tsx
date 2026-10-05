import { useEffect, useMemo, useState } from "react";
import { faviconFor, siteOf } from "../lib/url";
import "./CookiesPage.css";

type CookiesPageProps = {
  initialSite?: string;
  onClose?: () => void;
};

type SiteGroup = { site: string; cookies: BrowserCookie[] };

function cookieKey(c: BrowserCookie) {
  return `${c.domain}|${c.path}|${c.name}`;
}

function formatExpiry(c: BrowserCookie) {
  if (c.session || !c.expirationDate) return "When the browser closes";
  return new Date(c.expirationDate * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CookiesPage({ initialSite, onClose }: CookiesPageProps) {
  const [cookies, setCookies] = useState<BrowserCookie[] | null>(null);
  const [query, setQuery] = useState(initialSite ?? "");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialSite ? [siteOf(initialSite)] : []));
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    return Promise.resolve(window.api?.getAllCookies() ?? []).then(
      (all) => {
        setCookies(all);
        setError(null);
      },
      (e) => {
        setError(`Couldn't read cookies: ${String(e)}`);
        setCookies([]);
      }
    );
  }

  useEffect(() => {
    refresh();
    // Cookies change underneath us while browsing in other tabs.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!confirmClearAll) return;
    const id = window.setTimeout(() => setConfirmClearAll(false), 4000);
    return () => window.clearTimeout(id);
  }, [confirmClearAll]);

  const groups = useMemo<SiteGroup[]>(() => {
    if (!cookies) return [];
    const map = new Map<string, BrowserCookie[]>();
    for (const c of cookies) {
      const site = siteOf(c.domain ?? "");
      if (!site) continue;
      const list = map.get(site) ?? [];
      list.push(c);
      map.set(site, list);
    }
    const q = query.trim().toLowerCase();
    return Array.from(map, ([site, list]) => ({ site, cookies: list }))
      .filter((g) => !q || g.site.includes(q) || g.cookies.some((c) => c.name.toLowerCase().includes(q)))
      .sort((a, b) => a.site.localeCompare(b.site));
  }, [cookies, query]);

  const totalCookies = cookies?.length ?? 0;
  const siteCount = useMemo(() => new Set((cookies ?? []).map((c) => siteOf(c.domain ?? ""))).size, [cookies]);

  function toggle(site: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });
  }

  // Fade the row out first, then drop it from the list.
  function animateOut(key: string, work: Promise<void>, apply: () => void) {
    setRemoving((prev) => new Set(prev).add(key));
    Promise.all([work, new Promise((r) => window.setTimeout(r, 180))])
      .then(apply)
      .catch((e) => setError(`Couldn't remove: ${String(e)}`))
      .finally(() =>
        setRemoving((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        })
      );
  }

  function removeCookie(c: BrowserCookie) {
    const key = cookieKey(c);
    animateOut(key, window.api?.removeCookie(c) ?? Promise.resolve(), () =>
      setCookies((prev) => prev?.filter((x) => cookieKey(x) !== key) ?? null)
    );
  }

  function removeSite(site: string) {
    animateOut(`site:${site}`, window.api?.clearSiteData(site) ?? Promise.resolve(), () =>
      setCookies((prev) => prev?.filter((x) => siteOf(x.domain ?? "") !== site) ?? null)
    );
  }

  async function clearAll() {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      return;
    }
    setConfirmClearAll(false);
    try {
      await window.api?.clearAllSiteData();
    } catch (e) {
      setError(`Couldn't clear data: ${String(e)}`);
    }
    refresh();
  }

  return (
    <div className="cookies-page">
      <div className="cookies-inner">
        <div className="cookies-header">
          <div>
            <h1>Cookies and site data</h1>
            <p className="cookies-subtitle">
              {cookies === null
                ? "Loading…"
                : `${totalCookies} cookie${totalCookies === 1 ? "" : "s"} from ${siteCount} site${siteCount === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="cookies-header-actions">
            <button type="button" className="cookies-icon-btn" onClick={refresh} title="Refresh" aria-label="Refresh">
              <span className="material-symbols-outlined">refresh</span>
            </button>
            {onClose && (
              <button type="button" className="cookies-icon-btn" onClick={onClose} title="Close" aria-label="Close">
                <span className="material-symbols-outlined">close</span>
              </button>
            )}
          </div>
        </div>

        <div className="cookies-toolbar">
          <div className="cookies-search">
            <span className="material-symbols-outlined" aria-hidden="true">search</span>
            <input
              type="text"
              placeholder="Search sites or cookie names"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {query && (
              <button type="button" className="cookies-search-clear" onClick={() => setQuery("")} aria-label="Clear search">
                <span className="material-symbols-outlined">close</span>
              </button>
            )}
          </div>
          <button
            type="button"
            className={`cookies-danger-btn${confirmClearAll ? " confirm" : ""}`}
            onClick={clearAll}
            disabled={totalCookies === 0 && !confirmClearAll}
          >
            {confirmClearAll ? "Click again to delete everything" : "Delete all site data"}
          </button>
        </div>

        {error && <div className="cookies-error">{error}</div>}

        <div className="cookies-list">
          {cookies !== null && groups.length === 0 && (
            <div className="cookies-empty">
              <span className="material-symbols-outlined" aria-hidden="true">cookie</span>
              {query ? `No sites match “${query}”` : "No cookies stored"}
            </div>
          )}

          {groups.map((group) => {
            const isOpen = expanded.has(group.site);
            return (
              <div key={group.site} className={`cookies-site${removing.has(`site:${group.site}`) ? " removing" : ""}${isOpen ? " open" : ""}`}>
                <div className="cookies-site-row" onClick={() => toggle(group.site)}>
                  <img
                    className="cookies-site-favicon"
                    src={faviconFor(group.site)}
                    alt=""
                    onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")}
                  />
                  <span className="cookies-site-name">{group.site}</span>
                  <span className="cookies-site-count">
                    {group.cookies.length} cookie{group.cookies.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    className="cookies-icon-btn small"
                    title={`Delete data for ${group.site}`}
                    aria-label={`Delete data for ${group.site}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSite(group.site);
                    }}
                  >
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                  <span className="cookies-chevron material-symbols-outlined" aria-hidden="true">expand_more</span>
                </div>

                {isOpen && (
                  <div className="cookies-detail">
                    {group.cookies.map((c) => (
                      <div key={cookieKey(c)} className={`cookie-row${removing.has(cookieKey(c)) ? " removing" : ""}`}>
                        <div className="cookie-main">
                          <div className="cookie-name-line">
                            <span className="cookie-name">{c.name || "(no name)"}</span>
                            <span className="cookie-domain">
                              {c.domain}
                              {c.path && c.path !== "/" ? c.path : ""}
                            </span>
                          </div>
                          <code className="cookie-value" title={c.value}>
                            {c.value || "(empty)"}
                          </code>
                          <div className="cookie-meta">
                            <span>Expires: {formatExpiry(c)}</span>
                            {c.secure && <span className="cookie-chip">Secure</span>}
                            {c.httpOnly && <span className="cookie-chip">HttpOnly</span>}
                            {c.sameSite && c.sameSite !== "unspecified" && (
                              <span className="cookie-chip">SameSite={c.sameSite}</span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="cookies-icon-btn small"
                          title="Delete cookie"
                          aria-label={`Delete cookie ${c.name}`}
                          onClick={() => removeCookie(c)}
                        >
                          <span className="material-symbols-outlined">close</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
