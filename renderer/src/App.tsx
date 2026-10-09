import { useState, useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ChangeEvent, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import "./App.css";
import logo from "./assets/logos/Logo-Orange.png";
import backIcon from "./assets/Icons/Back-Grey.png";
import forwardIcon from "./assets/Icons/Forward-Grey.png";
import refreshIcon from "./assets/Icons/Refresh-Grey.png";
import cursorIcon from "./assets/Icons/cursor-white.png";
import stopIcon from "./assets/Icons/Stop-white.png";
import pauseIcon from "./assets/Icons/Pause-White.png";
import playIcon from "./assets/Icons/Play-White.png";
import NewTabPage from "./pages/NewTabPage";
import ChatPage from "./pages/ChatPage";
import { useLoadingText } from "./hooks/useLoadingText";
import { useImageAttachment } from "./hooks/useImageAttachment";
import { classifyAsTask, useTaskSuggestion } from "./hooks/useTaskSuggestion";
import HistoryPage, { type HistoryEntry } from "./pages/HistoryPage";
import CookiesPage from "./pages/CookiesPage";
import ContextMenu, { type ContextMenuState, type MenuItem } from "./components/ContextMenu";
import DevToolsPanel, { type DevToolsRequest } from "./components/DevToolsPanel";
import { formatDisplayUrl, hostnameOf, looksLikeUrl, searchEngineLabel, searchEngineName, setSearchEngine, siteOf, toNavigableUrl, webSearchUrl } from "./lib/url";
import SettingsPage from "./pages/SettingsPage";

const NEW_TAB_URL = "indus://newtab";
const HISTORY_URL = "indus://history";
const COOKIES_URL = "indus://cookies";
const SETTINGS_URL = "indus://settings";
const TAB_STATE_STORAGE_KEY = "indus-browser.tabs.v1";
const HISTORY_STORAGE_KEY = "indus-browser.history.v1";
const SIDEBAR_SESSIONS_STORAGE_KEY = "indus-browser.sidebar-sessions.v1";

// Auto mode asks Jev whether each message is a browser task (run the agent) or chat (reply).
type AssistantMode = 'agent' | 'chat' | 'auto';
const ASSISTANT_MODE_LABELS: Record<AssistantMode, string> = { auto: 'Auto', agent: 'Agent', chat: 'Chat' };
const DEVTOOLS_WIDTH_STORAGE_KEY = "indus-browser.devtools-width.v1";
// This window's identity, fixed for its lifetime (main.ts createWindow).
// Incognito windows browse in an in-memory partition, record no history and
// keep their tabs only for the life of the window.
const WINDOW_CONFIG = window.api?.windowConfig ?? { incognito: false, partition: "persist:indus-browser" };
const IS_INCOGNITO = WINDOW_CONFIG.incognito;
const isNewTabUrl = (url: string) => url === NEW_TAB_URL;
const isChatUrl = (url: string) => url.startsWith("indus://chat");
const isHistoryUrl = (url: string) => url === HISTORY_URL;
const isCookiesUrl = (url: string) => url.startsWith(COOKIES_URL);
const isSettingsUrl = (url: string) => url === SETTINGS_URL;

// Chrome's zoom presets.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const TAB_CLOSE_ANIMATION_MS = 150;
const TAB_GAP = 6;

// Generic globe shown when a page has no favicon (or it fails to load).
function TabFavicon({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img src={src} alt="" className="tab-favicon" onError={() => setFailed(true)} />;
  }
  return (
    <svg className="tab-favicon" viewBox="0 0 24 24" fill="none" stroke="#9da0a6" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
    </svg>
  );
}

function nextZoomStep(current: number, direction: 1 | -1) {
  if (direction === 1) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
}

// Pinch-zoom view of a webview: transform `translate(x, y) scale(scale)` with origin 0 0.
type PinchView = { scale: number; x: number; y: number };
const PINCH_IDENTITY: PinchView = { scale: 1, x: 0, y: 0 };

// Keep the scaled webview covering its own box, so no gap ever shows at the edges.
function clampPinchView(view: PinchView, width: number, height: number): PinchView {
  if (view.scale <= 1) return PINCH_IDENTITY;
  const clamp = (v: number, min: number) => Math.max(min, Math.min(0, v));
  return { scale: view.scale, x: clamp(view.x, width * (1 - view.scale)), y: clamp(view.y, height * (1 - view.scale)) };
}

// Runtime-only, per-tab state that shouldn't be persisted with the tab list.
type TabRuntime = {
  zoom?: number;
  pinch?: number;
  audible?: boolean;
  muted?: boolean;
  error?: { kind: "load"; code: number; description: string; url: string } | { kind: "crash" };
};

type OmniboxSuggestion = {
  kind: "search" | "url" | "history" | "tab";
  label: string;
  detail?: string;
  url: string;
  tabId?: string;
};

function friendlyLoadError(code: number, host: string) {
  if (code === -105 || code === -137) return `${host || "This site"}’s server IP address could not be found.`;
  if (code === -106) return "You’re not connected to the internet.";
  if (code === -102) return `${host || "The site"} refused to connect.`;
  if (code === -118 || code === -7) return `${host || "The site"} took too long to respond.`;
  if (code === -101 || code === -100) return "The connection was reset.";
  if (code <= -200 && code > -300) return "Your connection to this site is not private.";
  return "The page couldn’t be loaded.";
}
type SearchRoute = {
  routing: "web-search" | "ai-chat";
  chatTitle?: string;
};
type ApiResponse = {
  error?: boolean;
  data?: unknown;
  status?: number;
  text?: string;
};

function isInternalUrl(url: string) {
  return isNewTabUrl(url) || isChatUrl(url) || isHistoryUrl(url) || isCookiesUrl(url) || isSettingsUrl(url);
}

function tabDisplayTitle(tab: { url: string; title?: string }) {
  if (isNewTabUrl(tab.url)) return "New Tab";
  if (isHistoryUrl(tab.url)) return "History";
  if (isCookiesUrl(tab.url)) return "Cookies and site data";
  if (isSettingsUrl(tab.url)) return "Settings";
  return tab.title || tab.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
}

function loadHistory(): HistoryEntry[] {
  if (IS_INCOGNITO) return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function guessFaviconUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  } catch {
    return null;
  }
}

type Tab = {
  id: string;
  url: string;
  title?: string;
  isActive: boolean;
  faviconUrl?: string | null;
  isLoading?: boolean;
  history: string[];
  historyIndex: number;
};

const DEFAULT_TABS: Tab[] = [
  {
    id: "1Kw345fg178",
    url: "https://example.com",
    isActive: false,
    title: "Example",
    faviconUrl: null,
    isLoading: false,
    history: ["https://example.com"],
    historyIndex: 0,
  },
  {
    id: "2witsnghfiw",
    url: "https://github.com",
    isActive: true,
    title: "GitHub",
    faviconUrl: null,
    isLoading: false,
    history: ["https://github.com"],
    historyIndex: 0,
  },
];

// A fresh incognito window opens a single tab: a New Tab, or the link it was opened for.
function incognitoStartTabs(): Tab[] {
  const url = WINDOW_CONFIG.initialUrl ?? NEW_TAB_URL;
  const isPage = !isInternalUrl(url);
  return [{
    id: crypto.randomUUID(),
    url,
    title: isPage ? undefined : "New Tab",
    isActive: true,
    faviconUrl: isPage ? guessFaviconUrl(url) : null,
    isLoading: isPage,
    history: [url],
    historyIndex: 0,
  }];
}

function defaultTabs(): Tab[] {
  return IS_INCOGNITO ? incognitoStartTabs() : cloneTabs(DEFAULT_TABS);
}

// Regular windows restore their tabs across launches (localStorage). Incognito
// tabs go in sessionStorage instead: private to this window, kept across a
// reload of the UI, and gone with the window and its in-memory session.
function tabStateStorage(): Storage {
  return IS_INCOGNITO ? window.sessionStorage : window.localStorage;
}

function cloneTabs(tabs: Tab[]): Tab[] {
  return tabs.map((tab) => ({
    ...tab,
    history: [...tab.history],
  }));
}

function normalizeTabs(tabs: unknown): Tab[] {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return defaultTabs();
  }

  const normalizedTabs = tabs
    .map((tab: any) => {
      const url = typeof tab?.url === "string" && tab.url ? tab.url : NEW_TAB_URL;
      const history = Array.isArray(tab?.history)
        ? tab.history.filter((entry: unknown): entry is string => typeof entry === "string" && entry.length > 0)
        : [];
      const resolvedHistory = history.length > 0 ? history : [url];
      const resolvedHistoryIndex = typeof tab?.historyIndex === "number"
        ? Math.min(Math.max(0, Math.floor(tab.historyIndex)), resolvedHistory.length - 1)
        : resolvedHistory.length - 1;

      return {
        id: typeof tab?.id === "string" && tab.id ? tab.id : crypto.randomUUID(),
        url,
        title: typeof tab?.title === "string" ? tab.title : undefined,
        isActive: Boolean(tab?.isActive),
        faviconUrl: isInternalUrl(url)
          ? null
          : (typeof tab?.faviconUrl === "string" || tab?.faviconUrl === null ? tab.faviconUrl : null),
        isLoading: isInternalUrl(url) ? false : Boolean(tab?.isLoading),
        history: resolvedHistory,
        historyIndex: resolvedHistoryIndex,
      } as Tab;
    })
    .filter((tab: Tab) => typeof tab.url === "string" && tab.url.length > 0);

  if (normalizedTabs.length === 0) {
    return defaultTabs();
  }

  if (!normalizedTabs.some((tab) => tab.isActive)) {
    normalizedTabs[normalizedTabs.length - 1].isActive = true;
  }

  return normalizedTabs;
}

function loadPersistedTabs(): Tab[] {
  try {
    const raw = tabStateStorage().getItem(TAB_STATE_STORAGE_KEY);
    if (!raw) {
      return defaultTabs();
    }

    return normalizeTabs(JSON.parse(raw));
  } catch {
    return defaultTabs();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Search route request timed out"));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function parseSearchRouteJson(text: string): SearchRoute | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(trimmed);
    return parseSearchRoute(parsed);
  } catch {
    const routingMatch = trimmed.match(/routing\s*[:=]\s*["']?(web-search|ai-chat)["']?/i);
    if (!routingMatch) return null;

    const chatTitleMatch = trimmed.match(/chatTitle\s*[:=]\s*["']([^"']+)["']/i);
    return {
      routing: routingMatch[1] as SearchRoute["routing"],
      chatTitle: chatTitleMatch?.[1],
    };
  }
}

function parseSearchRoute(value: unknown): SearchRoute | null {
  if (!value) return null;

  if (typeof value === "string") {
    return parseSearchRouteJson(value);
  }

  if (typeof value !== "object") return null;

  const data = value as Record<string, unknown>;
  if (data.routing === "web-search" || data.routing === "ai-chat") {
    return {
      routing: data.routing,
      chatTitle: typeof data.chatTitle === "string" ? data.chatTitle : undefined,
    };
  }

  for (const key of ["reply", "output", "message", "content", "data"]) {
    const nested = parseSearchRoute(data[key]);
    if (nested) return nested;
  }

  return null;
}

/**
 * Closes a popover on an outside press or when the window loses focus. Clicks
 * into a <webview> never reach this document, but they do blur the window.
 */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onBlur = () => onCloseRef.current();
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, ref]);
}

function App() {

  function activateTab(targetId: string) {
    setTabs((currentTabs) =>
      currentTabs.some((tab) => tab.id === targetId && !tab.isActive)
        ? currentTabs.map((tab) => ({ ...tab, isActive: tab.id === targetId }))
        : currentTabs
    );
    focusTabContent(targetId);
  }

  // Like Chrome: switching to a page focuses the page, a New Tab focuses the omnibox.
  function focusTabContent(tabId: string) {
    window.requestAnimationFrame(() => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (tab && isNewTabUrl(tab.url)) {
        focusAddressBar(true);
        return;
      }
      (webviewRefs.current.get(tabId) as any)?.focus?.();
    });
  }

  // Tabs opened from a page land right after it (and after earlier tabs it opened).
  const openerByTabRef = useRef<Map<string, string>>(new Map());
  const [enteringTabIds, setEnteringTabIds] = useState<Set<string>>(new Set());

  function markTabEntering(tabId: string) {
    setEnteringTabIds((prev) => new Set(prev).add(tabId));
    window.setTimeout(() => {
      setEnteringTabIds((prev) => {
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
    }, 260);
  }

  function addTab(newUrl: string, opts: { background?: boolean; openerId?: string } = {}) {
    const isLoadableUrl = !isInternalUrl(newUrl);
    const newTab: Tab = {
      id: crypto.randomUUID(),
      url: newUrl,
      title: isLoadableUrl ? undefined : "New Tab",
      isActive: !opts.background,
      faviconUrl: isLoadableUrl ? guessFaviconUrl(newUrl) : null,
      isLoading: isLoadableUrl,
      history: [newUrl],
      historyIndex: 0,
    };
    const openerId = opts.openerId;
    if (openerId) openerByTabRef.current.set(newTab.id, openerId);
    markTabEntering(newTab.id);

    setTabs((currentTabs) => {
      const base = opts.background ? currentTabs : currentTabs.map((tab) => ({ ...tab, isActive: false }));
      const openerIndex = openerId ? base.findIndex((t) => t.id === openerId) : -1;
      if (openerIndex === -1) return [...base, newTab];
      let insertAt = openerIndex + 1;
      while (insertAt < base.length && openerByTabRef.current.get(base[insertAt].id) === openerId) insertAt++;
      return [...base.slice(0, insertAt), newTab, ...base.slice(insertAt)];
    });

    if (!opts.background) {
      if (isLoadableUrl) {
        setAddressBarValue(newUrl);
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else {
        setAddressBarValue("");
        if (isNewTabUrl(newUrl)) window.requestAnimationFrame(() => focusAddressBar(true));
      }
    }
    return newTab.id;
  }

  /** Activates an existing tab whose URL matches, or opens `url` in a new one. */
  function openSingletonTab(url: string, matches: (tabUrl: string) => boolean) {
    const existing = tabsRef.current.find((t) => matches(t.url) && !closingIdsRef.current.has(t.id));
    if (existing) {
      activateTab(existing.id);
      if (existing.url !== url) updateTabUrl(existing.id, url);
    } else {
      addTab(url);
    }
  }

  // ---- Closing tabs -------------------------------------------------------
  // Tabs animate out before removal; while that runs they're "closing" and
  // ignored by every lookup, so a double click / double Ctrl+W can never take
  // out a second tab by accident.
  const closingIdsRef = useRef<Set<string>>(new Set());
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  // Chrome keeps tab widths frozen while you close tabs with the mouse, so the
  // next tab's close button slides under the cursor; they relax on mouse-leave.
  const [frozenTabWidth, setFrozenTabWidth] = useState<number | null>(null);

  function rememberClosedTab(tab: Tab, index: number) {
    if (isNewTabUrl(tab.url)) return;
    closedTabsRef.current = [{ tab: { ...tab, isActive: false, isLoading: false }, index }, ...closedTabsRef.current].slice(0, 25);
  }

  function disposeTabRuntime(tabId: string) {
    pinchScaleRef.current.delete(tabId);
    openerByTabRef.current.delete(tabId);
    const wcId = getWebContentsIdForTab(tabId);
    if (wcId != null && devtools[tabId]?.open) window.api?.closeDevTools(wcId);
    setDevtools((prev) => {
      if (!prev[tabId]) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabRuntime((prev) => {
      if (!prev[tabId]) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }

  function closeTab(targetId: string, opts: { viaMouse?: boolean } = {}) {
    if (closingIdsRef.current.has(targetId)) return;
    const live = tabsRef.current.filter((t) => !closingIdsRef.current.has(t.id));
    const index = live.findIndex((t) => t.id === targetId);
    if (index === -1) return;
    const closing = live[index];

    // Never leave an empty window: the last tab turns back into a New Tab,
    // and closing a lone New Tab does nothing.
    if (live.length === 1) {
      if (isNewTabUrl(closing.url)) return;
      rememberClosedTab(closing, index);
      disposeTabRuntime(targetId);
      const freshId = crypto.randomUUID();
      setTabs((currentTabs) =>
        currentTabs.map((t) =>
          t.id === targetId
            ? { id: freshId, url: NEW_TAB_URL, title: "New Tab", isActive: true, faviconUrl: null, isLoading: false, history: [NEW_TAB_URL], historyIndex: 0 }
            : t
        )
      );
      setAddressBarValue("");
      window.requestAnimationFrame(() => focusAddressBar(true));
      return;
    }

    if (opts.viaMouse) setFrozenTabWidth((w) => w ?? tabWidth);
    rememberClosedTab(closing, index);
    disposeTabRuntime(targetId);

    closingIdsRef.current.add(targetId);
    setClosingIds(new Set(closingIdsRef.current));

    if (closing.isActive) {
      const next = live[index + 1] ?? live[index - 1];
      setTabs((currentTabs) => currentTabs.map((t) => ({ ...t, isActive: t.id === next.id })));
      focusTabContent(next.id);
    }

    window.setTimeout(() => {
      closingIdsRef.current.delete(targetId);
      setClosingIds(new Set(closingIdsRef.current));
      setTabs((currentTabs) => currentTabs.filter((t) => t.id !== targetId));
    }, TAB_CLOSE_ANIMATION_MS);
  }

  function closeOtherTabs(keepId: string, onlyToRight = false) {
    const live = tabsRef.current.filter((t) => !closingIdsRef.current.has(t.id));
    const keepIndex = live.findIndex((t) => t.id === keepId);
    const doomed = live.filter((t, i) => t.id !== keepId && (!onlyToRight || i > keepIndex));
    if (doomed.length === 0) return;
    // Remember in reverse so Ctrl+Shift+T restores them left-to-right.
    [...doomed].reverse().forEach((t) => {
      rememberClosedTab(t, live.indexOf(t));
      disposeTabRuntime(t.id);
    });
    const doomedIds = new Set(doomed.map((t) => t.id));
    setTabs((currentTabs) =>
      currentTabs.filter((t) => !doomedIds.has(t.id)).map((t) => ({ ...t, isActive: t.id === keepId }))
    );
    focusTabContent(keepId);
  }

  function reopenClosedTab() {
    const [lastClosed, ...rest] = closedTabsRef.current;
    if (!lastClosed) return;
    closedTabsRef.current = rest;
    const restored = { ...lastClosed.tab, isActive: true };
    markTabEntering(restored.id);
    setTabs((currentTabs) => {
      const base = currentTabs.filter((t) => t.id !== restored.id).map((t) => ({ ...t, isActive: false }));
      const at = Math.min(lastClosed.index, base.length);
      return [...base.slice(0, at), restored, ...base.slice(at)];
    });
    focusTabContent(restored.id);
  }

  function recordHistoryVisit(url: string) {
    if (IS_INCOGNITO || isInternalUrl(url)) return;
    setHistory((prev) => {
      if (prev[0]?.url === url) return prev;
      return [{ url, title: url, visitedAt: Date.now() }, ...prev].slice(0, 500);
    });
  }

  const [tabs, setTabs] = useState<Tab[]>(() => loadPersistedTabs());

  // Keep a ref to always have the current tabs. A layout effect, so it's
  // already current in rAF / event callbacks that run before the next paint.
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    // Debounced: title/favicon/loading updates can fire many times a second
    // while a page loads, and JSON.stringify-ing the whole tab (+ history) set
    // on every single one was a needless main-thread cost.
    const timeoutId = window.setTimeout(() => {
      try {
        tabStateStorage().setItem(TAB_STATE_STORAGE_KEY, JSON.stringify(tabs));
      } catch {
        // Ignore storage failures and keep the browser usable.
      }
    }, 400);
    return () => window.clearTimeout(timeoutId);
  }, [tabs]);

  // Expose tabs to the main process via executeJavaScript
  useEffect(() => {
    (window as any).__tabs = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, isActive: t.isActive }));
  }, [tabs]);

  const webviewRefs = useRef<Map<string, HTMLWebViewElement>>(new Map());
  // Tabs whose current history entry was just navigated to (typed URL, back, forward).
  // The first did-navigate that follows is the destination itself, possibly after
  // redirects, so it must replace that entry rather than push a new one.
  const pendingNavRef = useRef<Set<string>>(new Set());
  // URL each webview was last told to load or itself reported. The <webview src>
  // is frozen at mount; later changes to tab.url are applied with loadURL only when
  // they differ from this. Feeding the page's own URL changes back through src made
  // the webview load the page a second time, which could land after a back press.
  const webviewKnownUrlRef = useRef<Map<string, string>>(new Map());
  const webviewInitialSrcRef = useRef<Map<string, string>>(new Map());
  const webviewContainerRef = useRef<HTMLDivElement>(null);
  //maps tab id to webview element inside .current

  // Per-tab CSS scale + pan offset applied by pinch-to-zoom (see onPinchZoom effect below).
  const pinchScaleRef = useRef<Map<string, PinchView>>(new Map());

  // ---- Per-tab runtime state (zoom, audio, load errors) --------------------
  const [tabRuntime, setTabRuntime] = useState<Record<string, TabRuntime>>({});

  function patchRuntime(tabId: string, patch: Partial<TabRuntime>) {
    setTabRuntime((prev) => ({ ...prev, [tabId]: { ...prev[tabId], ...patch } }));
  }

  function getWebContentsIdForTab(tabId: string): number | null {
    const el = webviewRefs.current.get(tabId) as any;
    if (!el) return null;
    try {
      return el.getWebContentsId();
    } catch {
      return null; // not attached yet
    }
  }

  function findTabByWebContentsId(wcId: number) {
    return tabsRef.current.find((t) => getWebContentsIdForTab(t.id) === wcId);
  }

  function syncZoomFromPage(tabId: string) {
    const el = webviewRefs.current.get(tabId) as any;
    if (!el) return;
    let factor: number;
    try {
      factor = el.getZoomFactor();
    } catch {
      return;
    }
    setTabRuntime((prev) => (prev[tabId]?.zoom === factor ? prev : { ...prev, [tabId]: { ...prev[tabId], zoom: factor } }));
  }

  function toggleTabMuted(tabId: string) {
    const el = webviewRefs.current.get(tabId) as any;
    if (!el) return;
    try {
      const muted = !el.isAudioMuted();
      el.setAudioMuted(muted);
      patchRuntime(tabId, { muted });
    } catch {
      // guest not attached
    }
  }

  useEffect(() => {
    const cleanup = window.api?.onAudioState(({ webContentsId, audible }) => {
      const tab = findTabByWebContentsId(webContentsId);
      if (tab) patchRuntime(tab.id, { audible });
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onNavCommit(({ webContentsId, url, replaced }) => {
      const tab = findTabByWebContentsId(webContentsId);
      if (!tab) return;
      // A commit right after a typed URL / back / forward is that destination
      // (post-redirect); one that replaced Chromium's entry (location.replace,
      // replaceState, client redirect) must not add a history entry either.
      const fromPending = pendingNavRef.current.delete(tab.id);
      updateTabUrl(tab.id, url, fromPending || replaced, true);
    });
    return () => cleanup?.();
  }, []);

  // ---- Docked DevTools -----------------------------------------------------
  const [devtools, setDevtools] = useState<Record<string, DevToolsRequest>>({});
  const [devtoolsWidth, setDevtoolsWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem(DEVTOOLS_WIDTH_STORAGE_KEY));
      return saved >= 280 ? saved : 460;
    } catch {
      return 460;
    }
  });
  const devtoolsResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isResizingDevtools, setIsResizingDevtools] = useState(false);

  function openDevToolsForTab(tabId: string, inspectAt?: { x: number; y: number }) {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab || isInternalUrl(tab.url)) return;
    setDevtools((prev) => ({ ...prev, [tabId]: { open: true, seq: (prev[tabId]?.seq ?? 0) + 1, inspectAt } }));
  }

  function closeDevToolsForTab(tabId: string) {
    const wcId = getWebContentsIdForTab(tabId);
    if (wcId != null) window.api?.closeDevTools(wcId);
    setDevtools((prev) => (prev[tabId]?.open ? { ...prev, [tabId]: { ...prev[tabId], open: false, inspectAt: undefined } } : prev));
    focusTabContent(tabId);
  }

  function toggleDevToolsForTab(tabId: string) {
    if (devtools[tabId]?.open) closeDevToolsForTab(tabId);
    else openDevToolsForTab(tabId);
  }

  useEffect(() => {
    const cleanup = window.api?.onDevToolsClosed((targetId) => {
      const tab = findTabByWebContentsId(targetId);
      if (!tab) return;
      setDevtools((prev) => (prev[tab.id]?.open ? { ...prev, [tab.id]: { ...prev[tab.id], open: false } } : prev));
    });
    return () => cleanup?.();
  }, []);

  // A tab that leaves the web (e.g. to History) drops its <webview>, and with
  // it the inspected page, so its DevTools host has to go too.
  useEffect(() => {
    setDevtools((prev) => {
      const stale = Object.keys(prev).filter((id) => {
        const tab = tabs.find((t) => t.id === id);
        return !tab || isInternalUrl(tab.url);
      });
      if (stale.length === 0) return prev;
      const next = { ...prev };
      stale.forEach((id) => delete next[id]);
      return next;
    });
  }, [tabs]);

  useEffect(() => {
    if (!isResizingDevtools) return;
    const onMove = (e: MouseEvent) => {
      const drag = devtoolsResizeRef.current;
      if (!drag) return;
      const max = Math.max(320, window.innerWidth - 360);
      setDevtoolsWidth(Math.min(max, Math.max(280, drag.startWidth + (drag.startX - e.clientX))));
    };
    const onUp = () => setIsResizingDevtools(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
  }, [isResizingDevtools]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DEVTOOLS_WIDTH_STORAGE_KEY, String(Math.round(devtoolsWidth)));
    } catch {
      // Ignore storage failures.
    }
  }, [devtoolsWidth]);

  // ---- Context menus ---------------------------------------------------------
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const SEPARATOR: MenuItem = { type: "separator" };

  function handleTabContextMenu(e: ReactMouseEvent, tab: Tab) {
    e.preventDefault();
    e.stopPropagation();
    const live = tabsRef.current.filter((t) => !closingIdsRef.current.has(t.id));
    const index = live.findIndex((t) => t.id === tab.id);
    const hasPage = !isInternalUrl(tab.url);
    const muted = Boolean(tabRuntime[tab.id]?.muted);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New tab to the right", icon: "add", onSelect: () => addTab(NEW_TAB_URL, { openerId: tab.id }) },
        SEPARATOR,
        { label: "Reload", icon: "refresh", shortcut: "Ctrl+R", disabled: !hasPage, onSelect: () => (webviewRefs.current.get(tab.id) as any)?.reload() },
        { label: "Duplicate", icon: "tab_duplicate", onSelect: () => addTab(tab.url, { openerId: tab.id }) },
        { label: muted ? "Unmute tab" : "Mute tab", icon: muted ? "volume_up" : "volume_off", disabled: !hasPage, onSelect: () => toggleTabMuted(tab.id) },
        SEPARATOR,
        { label: "Close", icon: "close", shortcut: "Ctrl+W", onSelect: () => closeTab(tab.id) },
        { label: "Close other tabs", disabled: live.length <= 1, onSelect: () => closeOtherTabs(tab.id) },
        { label: "Close tabs to the right", disabled: index === live.length - 1, onSelect: () => closeOtherTabs(tab.id, true) },
        SEPARATOR,
        { label: "Reopen closed tab", icon: "undo", shortcut: "Ctrl+Shift+T", disabled: closedTabsRef.current.length === 0, onSelect: reopenClosedTab },
      ],
    });
  }

  function openPageContextMenu(tabId: string, el: any, params: any) {
    // Electron reports webview context-menu coordinates in the embedder's
    // (window) space — which is also what inspectElement / copyImageAt expect
    // for a guest, so they're passed straight through like Chrome does.
    const x: number = params.x;
    const y: number = params.y;
    const tab = tabsRef.current.find((t) => t.id === tabId);
    const copy = (text: string) => window.api?.writeClipboardText(text);
    const items: MenuItem[] = [];

    const linkURL: string = params.linkURL || "";
    const srcURL: string = params.srcURL || "";
    const selection: string = (params.selectionText || "").trim();
    const isImage = params.mediaType === "image" && srcURL;

    if (linkURL) {
      items.push(
        { label: "Open link in new tab", icon: "open_in_new", onSelect: () => addTab(linkURL, { background: true, openerId: tabId }) },
        ...(IS_INCOGNITO
          ? []
          : [{ label: "Open link in incognito window", icon: "domino_mask", onSelect: () => window.api?.openIncognitoWindow(linkURL) }]),
        { label: "Copy link address", icon: "link", onSelect: () => copy(linkURL) },
        SEPARATOR
      );
    }

    if (isImage) {
      items.push(
        { label: "Open image in new tab", icon: "image", onSelect: () => addTab(srcURL, { background: true, openerId: tabId }) },
        { label: "Save image as…", icon: "download", onSelect: () => el.downloadURL(srcURL) },
        { label: "Copy image", icon: "content_copy", onSelect: () => el.copyImageAt(x, y) },
        { label: "Copy image address", icon: "link", onSelect: () => copy(srcURL) },
        SEPARATOR
      );
    }

    if (params.isEditable) {
      const suggestions: string[] = (params.dictionarySuggestions ?? []).slice(0, 4);
      suggestions.forEach((word) => items.push({ label: word, icon: "spellcheck", onSelect: () => el.replaceMisspelling(word) }));
      if (suggestions.length) items.push(SEPARATOR);
      const flags = params.editFlags ?? {};
      items.push(
        { label: "Undo", icon: "undo", shortcut: "Ctrl+Z", disabled: !flags.canUndo, onSelect: () => el.undo() },
        { label: "Redo", icon: "redo", shortcut: "Ctrl+Y", disabled: !flags.canRedo, onSelect: () => el.redo() },
        SEPARATOR,
        { label: "Cut", icon: "content_cut", shortcut: "Ctrl+X", disabled: !flags.canCut, onSelect: () => el.cut() },
        { label: "Copy", icon: "content_copy", shortcut: "Ctrl+C", disabled: !flags.canCopy, onSelect: () => el.copy() },
        { label: "Paste", icon: "content_paste", shortcut: "Ctrl+V", disabled: !flags.canPaste, onSelect: () => el.paste() },
        { label: "Select all", icon: "select_all", shortcut: "Ctrl+A", disabled: !flags.canSelectAll, onSelect: () => el.selectAll() },
        SEPARATOR
      );
    } else if (selection) {
      const preview = selection.length > 28 ? `${selection.slice(0, 28)}…` : selection;
      items.push(
        { label: "Copy", icon: "content_copy", shortcut: "Ctrl+C", onSelect: () => el.copy() },
        { label: `Search ${searchEngineName()} for “${preview}”`, icon: "search", onSelect: () => addTab(webSearchUrl(selection), { openerId: tabId }) },
        SEPARATOR
      );
    }

    if (!linkURL && !isImage && !params.isEditable && !selection) {
      items.push(
        { label: "Back", icon: "arrow_back", shortcut: "Alt+Left", disabled: !tab || tab.historyIndex <= 0, onSelect: goBack },
        { label: "Forward", icon: "arrow_forward", shortcut: "Alt+Right", disabled: !tab || tab.historyIndex >= tab.history.length - 1, onSelect: goForward },
        { label: "Reload", icon: "refresh", shortcut: "Ctrl+R", onSelect: () => el.reload() },
        SEPARATOR,
        { label: "Print…", icon: "print", onSelect: () => el.print() },
        SEPARATOR
      );
    }

    items.push(
      { label: "Inspect", icon: "code", shortcut: "Ctrl+Shift+I", onSelect: () => openDevToolsForTab(tabId, { x, y }) },
      { label: showMouseCoords ? "Hide mouse coordinates" : "Show mouse coordinates", icon: "my_location", onSelect: () => setShowMouseCoords((v) => !v) }
    );

    setContextMenu({ x, y, items });
  }

  // ---- Webview events --------------------------------------------------------
  const [hoverUrl, setHoverUrl] = useState("");

  // The listener effect below only re-binds when tabs come and go, so it calls
  // through this ref to always reach the latest handlers and state.
  const pageEventsRef = useRef<{
    contextMenu: (tabId: string, el: any, params: any) => void;
    hoverUrl: (tabId: string, url: string) => void;
    syncZoom: (tabId: string) => void;
  } | null>(null);
  useLayoutEffect(() => {
    pageEventsRef.current = {
      contextMenu: openPageContextMenu,
      hoverUrl: (tabId, url) => {
        if (tabsRef.current.find((t) => t.isActive)?.id === tabId) setHoverUrl(url || "");
      },
      syncZoom: syncZoomFromPage,
    };
  });

  // Keyed by tab identity plus whether each tab currently has a <webview>
  // (not the full tab objects), so listeners re-bind only when tabs are
  // added/removed or a tab moves between an internal page and the web — not
  // on every title, favicon, or loading-state update.
  const tabIdsKey = tabs.map((t) => `${t.id}:${isInternalUrl(t.url) ? "i" : "w"}`).join(",");

  useEffect(() => {
    const currentRefs = webviewRefs.current;
    const bindings: { el: HTMLElement; event: string; handler: (e: any) => void }[] = [];

    tabsRef.current.forEach((tab) => {
      const el = currentRefs.get(tab.id) as any;
      if (!el) return;

      const on = (event: string, handler: (e: any) => void) => {
        el.addEventListener(event, handler);
        bindings.push({ el, event, handler });
      };
      const patchTab = (patch: Partial<Tab>) =>
        setTabs((currentTabs) => currentTabs.map((t) => (t.id === tab.id ? { ...t, ...patch } : t)));

      on("did-start-loading", () => {
        patchTab({ isLoading: true });
        patchRuntime(tab.id, { error: undefined });
      });

      // did-finish-load never fires for failed or stopped loads; this always does.
      on("did-stop-loading", () => {
        pendingNavRef.current.delete(tab.id);
        patchTab({ isLoading: false });
      });

      // History bookkeeping for did-navigate / did-navigate-in-page lives in the
      // browser:nav-commit listener, which also knows if an entry was replaced.
      on("did-navigate", (e) => {
        // Drop the placeholder title so the hostname fallback shows until the real one arrives
        setTabs((currentTabs) =>
          currentTabs.map((t) =>
            t.id === tab.id && t.title === "New Tab" && !isNewTabUrl(e.url)
              ? { ...t, title: undefined }
              : t
          )
        );
        recordHistoryVisit(e.url);
        pageEventsRef.current?.syncZoom(tab.id);
      });

      on("did-finish-load", () => {
        // page-title-updated can be missed (fired before listeners attached,
        // or the title never changed), leaving a stale "New Tab" — resync here.
        let liveTitle = "";
        try { liveTitle = el.getTitle?.() || ""; } catch {}
        setTabs((currentTabs) =>
          currentTabs.map((t) =>
            t.id === tab.id
              ? { ...t, isLoading: false, ...(liveTitle ? { title: liveTitle } : {}) }
              : t
          )
        );
      });

      on("did-fail-load", (e) => {
        // -3 is ERR_ABORTED: a stopped load or one superseded by another navigation.
        if (!e.isMainFrame || e.errorCode === -3) return;
        patchRuntime(tab.id, {
          error: { kind: "load", code: e.errorCode, description: e.errorDescription, url: e.validatedURL },
        });
        patchTab({ isLoading: false });
      });

      on("render-process-gone", () => {
        patchRuntime(tab.id, { error: { kind: "crash" }, audible: false });
        patchTab({ isLoading: false });
      });

      on("page-title-updated", (e) => {
        setTabs((currentTabs) =>
          currentTabs.map((t) =>
            t.id === tab.id ? { ...t, title: e.title || "Untitled" } : t
          )
        );
        if (e.title) {
          setHistory((prev) => {
            if (prev.length === 0 || prev[0].url !== tab.url || prev[0].title === e.title) return prev;
            return [{ ...prev[0], title: e.title }, ...prev.slice(1)];
          });
        }
      });

      on("page-favicon-updated", (e) => {
        const favicons: string[] = Array.isArray(e?.favicons) ? e.favicons : [];
        if (favicons.length === 0) return;
        patchTab({ faviconUrl: favicons[0] });
      });

      on("context-menu", (e) => pageEventsRef.current?.contextMenu(tab.id, el, e.params));
      on("update-target-url", (e) => pageEventsRef.current?.hoverUrl(tab.id, e.url));
      on("dom-ready", () => pageEventsRef.current?.syncZoom(tab.id));
    });

    return () => {
      bindings.forEach(({ el, event, handler }) => el.removeEventListener(event, handler));
    };
  }, [tabIdsKey]);


  const [showMouseCoords, setShowMouseCoords] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!showMouseCoords) return;
    const handleMouseMove = (e: MouseEvent) => {
      // Report coordinates relative to the active webview, not the full window.
      const wv = document.querySelector('webview[style*="display: flex"]');
      if (wv) {
        const rect = wv.getBoundingClientRect();
        setMousePos({ x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top) });
      } else {
        setMousePos({ x: Math.round(e.clientX), y: Math.round(e.clientY) });
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [showMouseCoords]);
  // A 'mode' message marks where the conversation switched between chat and the agent; its text is the side it switched to.
  type ChatMessage = { role: 'user' | 'agent' | 'reply' | 'warning' | 'supervisor' | 'mode'; text: string };
  type AgentHistoryMessage = ChatMessage & { role: Exclude<ChatMessage['role'], 'mode'> };
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  // The agent's notepad (its short-term memory), mirrored live from main. It belongs to
  // the sidebar conversation: saved with it, and sent into every agent run in it.
  const [agentNotes, setAgentNotes] = useState('');
  const [isNotepadOpen, setIsNotepadOpen] = useState(false);
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  // Task tips the agent has been sent in this conversation (automatic or asked for), newest last.
  const [receivedTips, setReceivedTips] = useState<{ id: string; auto: boolean; description: string; text: string }[]>([]);
  const [isTipsOpen, setIsTipsOpen] = useState(false);
  const [expandedTips, setExpandedTips] = useState<Set<string>>(new Set());
  // Message indexes of supervisor/warning notices whose open state was flipped from its default
  // (supervisor starts collapsed, warning starts expanded).
  const [toggledNotices, setToggledNotices] = useState<Set<number>>(new Set());
  const toggleNotice = (index: number) => setToggledNotices(prev => {
    const next = new Set(prev);
    if (!next.delete(index)) next.add(index);
    return next;
  });
  const [notepadFlash, setNotepadFlash] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [agentCursor, setAgentCursor] = useState<{ x: number; y: number } | null>(null);
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('agent');
  // Chat-mode conversation history sent to the conversant backend (separate from
  // chatMessages, which also mixes in agent-mode action steps).
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatStreamingReply, setChatStreamingReply] = useState<string | null>(null);
  const taskSuggestion = useTaskSuggestion();

  type SidebarSession = {
    id: string;
    mode: AssistantMode;
    title: string;
    messages: ChatMessage[];
    chatHistory: { role: 'user' | 'assistant'; content: string }[];
    /** The agent's notepad for this conversation; carried into every run in it. */
    agentNotes?: string;
    /** Set once an agent title has been generated, so it isn't requested again. */
    titled?: boolean;
    updatedAt: number;
  };

  const [sidebarSessions, setSidebarSessions] = useState<SidebarSession[]>(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_SESSIONS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [currentSessionId, setCurrentSessionIdState] = useState<string>(() => crypto.randomUUID());
  // Agent events arrive in listeners registered once, so they read the open conversation from here.
  const currentSessionIdRef = useRef(currentSessionId);
  function setCurrentSessionId(id: string) {
    currentSessionIdRef.current = id;
    setCurrentSessionIdState(id);
  }
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  // Read by agent event listeners, which are registered once.
  const assistantModeRef = useRef(assistantMode);
  assistantModeRef.current = assistantMode;
  // Conversations that were in Chat mode when a task was handed to the agent; they go back to Chat when it finishes.
  const handedOffSessionsRef = useRef(new Set<string>());

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_SESSIONS_STORAGE_KEY, JSON.stringify(sidebarSessions));
    } catch {
      // Ignore storage failures and keep the browser usable.
    }
  }, [sidebarSessions]);

  // Agent sessions start out titled with the first words of the task; a short generated title replaces that.
  function requestSessionTitle(sessionId: string, text: string) {
    window.api?.generateSessionTitle(text).then(result => {
      if (!result || result.error || !result.title) return;
      setSidebarSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title: result.title, titled: true } : s));
    }).catch(() => {});
  }

  const titleRequestedRef = useRef(new Set<string>());
  const sidebarSessionsRef = useRef(sidebarSessions);
  sidebarSessionsRef.current = sidebarSessions;

  useEffect(() => {
    if (chatMessages.length === 0) return;
    const firstUserMessage = chatMessages.find(m => m.role === 'user')?.text;
    // Also covers a chat that was handed to the agent: it starts as a chat session, so it's titled once the agent is running in it.
    const alreadyTitled = sidebarSessionsRef.current.find(s => s.id === currentSessionId)?.titled;
    if (assistantMode !== 'chat' && firstUserMessage && !alreadyTitled && !titleRequestedRef.current.has(currentSessionId)) {
      titleRequestedRef.current.add(currentSessionId);
      requestSessionTitle(currentSessionId, firstUserMessage);
    }
    const title = firstUserMessage?.slice(0, 40) || (assistantMode === 'agent' ? 'Agent task' : ASSISTANT_MODE_LABELS[assistantMode]);

    setSidebarSessions(prev => {
      const existing = prev.find(s => s.id === currentSessionId);
      let updated: SidebarSession[];
      if (existing) {
        updated = prev.map(s =>
          s.id === currentSessionId ? { ...s, mode: assistantMode, messages: chatMessages, chatHistory, agentNotes, updatedAt: Date.now() } : s
        );
      } else {
        updated = [
          { id: currentSessionId, mode: assistantMode, title, messages: chatMessages, chatHistory, agentNotes, updatedAt: Date.now() },
          ...prev,
        ];
      }
      updated.sort((a, b) => b.updatedAt - a.updatedAt);
      return updated.slice(0, 100);
    });
  }, [chatMessages, agentNotes]);

  function startNewSidebarSession() {
    setChatMessages([]);
    setChatHistory([]);
    setAgentNotes('');
    setReceivedTips([]);
    setExpandedTips(new Set());
    setExpandedNotes(new Set());
    setToggledNotices(new Set());
    setChatInput("");
    taskSuggestion.clear();
    setCurrentSessionId(crypto.randomUUID());
    setShowSessionHistory(false);
  }

  function openSidebarSession(session: SidebarSession) {
    setChatMessages(session.messages);
    setChatHistory(session.chatHistory);
    setAgentNotes(session.agentNotes ?? '');
    setReceivedTips([]);
    setExpandedTips(new Set());
    setExpandedNotes(new Set());
    setToggledNotices(new Set());
    setAssistantMode(session.mode);
    setCurrentSessionId(session.id);
    setShowSessionHistory(false);
    taskSuggestion.clear();
  }

  function deleteSidebarSession(sessionId: string) {
    if (runningAgentsRef.current[sessionId]) {
      window.api?.stopAgent(sessionId);
      setAgentRunState(sessionId, null);
    }
    setSidebarSessions(prev => prev.filter(s => s.id !== sessionId));
    if (sessionId === currentSessionId) {
      startNewSidebarSession();
    }
  }

  function formatSessionDate(timestamp: number): string {
    const date = new Date(timestamp);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  }
  const chatLoadingText = useLoadingText(isChatLoading);
  const imageAttachment = useImageAttachment();
  const [newTabRoutingError, setNewTabRoutingError] = useState<string | null>(null);
  const [newTabLeaving, setNewTabLeaving] = useState(false);
  const closedTabsRef = useRef<{ tab: Tab; index: number }[]>([]);
  const [showFindBar, setShowFindBar] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<{ activeMatch: number; matches: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  type DownloadEntry = { id: string; filename: string; percent: number | null; done: boolean; success?: boolean; path?: string };
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [showAssistantMenu, setShowAssistantMenu] = useState(false);
  const [platform, setPlatform] = useState<'win32' | 'darwin' | 'linux'>('win32');
  const [tabWidth, setTabWidth] = useState(240);
  // ---- Agents ---------------------------------------------------------------
  // Each sidebar conversation has its own agent, working in its own tab; several can
  // run at once. Their events arrive tagged with the conversation they belong to.
  const [runningAgents, setRunningAgents] = useState<Record<string, { paused: boolean }>>({});
  const runningAgentsRef = useRef(runningAgents);
  const isAgentRunning = !!runningAgents[currentSessionId];
  const isAgentPaused = !!runningAgents[currentSessionId]?.paused;
  // The notepad and tips belong to the agent, so they show only while the conversation is on the agent's side.
  const showAgentPanels = !showSessionHistory
    && (assistantMode === 'agent' || (assistantMode === 'auto' && lastRoute(chatMessages) === 'agent'));

  function setAgentRunState(sessionId: string, state: { paused: boolean } | null) {
    const next = { ...runningAgentsRef.current };
    if (state) next[sessionId] = state;
    else delete next[sessionId];
    runningAgentsRef.current = next;
    setRunningAgents(next);
    if (!state) {
      setStepDelays(prev => {
        if (!prev[sessionId]) return prev;
        const { [sessionId]: _removed, ...rest } = prev;
        return rest;
      });
    }
  }

  // The wait between steps the planner set for each running agent, and when its current wait ends.
  const [stepDelays, setStepDelays] = useState<Record<string, { ms: number; reason?: string; isDefault?: boolean; waitUntil?: number }>>({});
  const currentStepDelay = isAgentRunning ? stepDelays[currentSessionId] : undefined;
  const [stepDelayNow, setStepDelayNow] = useState(() => Date.now());
  useEffect(() => {
    if (!currentStepDelay?.waitUntil || currentStepDelay.waitUntil <= Date.now()) return;
    const timer = setInterval(() => setStepDelayNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [currentStepDelay?.waitUntil]);
  // Sub-second waits (like the default) would just flash "1s" every step, so they get no countdown.
  const stepWaitLeft = currentStepDelay?.waitUntil && currentStepDelay.ms >= 1000 && !isAgentPaused
    ? Math.ceil((currentStepDelay.waitUntil - stepDelayNow) / 1000)
    : 0;

  // Which tab each conversation's agent works in. A follow-up in the same conversation
  // continues in the same tab. Kept in a ref (main reads it through __agentTabs) and
  // mirrored in state so tabs re-render when an agent moves to another tab.
  const agentTabBySessionRef = useRef<Map<string, string>>(new Map());
  const [agentTabBySession, setAgentTabBySession] = useState<Record<string, string>>({});
  // Tabs an agent just opened, which may not have rendered yet: "not ready", not "closed".
  const pendingAgentTabsRef = useRef<Set<string>>(new Set());

  function setAgentTab(sessionId: string, tabId: string) {
    agentTabBySessionRef.current.set(sessionId, tabId);
    setAgentTabBySession(Object.fromEntries(agentTabBySessionRef.current));
  }

  /** Tabs that other conversations' running agents are working in. */
  function tabsBusyWithOtherAgents(sessionId: string): Set<string> {
    const busy = new Set<string>();
    for (const [sid, tabId] of agentTabBySessionRef.current) {
      if (sid !== sessionId && runningAgentsRef.current[sid]) busy.add(tabId);
    }
    return busy;
  }

  /**
   * Picks the tab a conversation's agent works in: the tab it used before, else the
   * tab you're on (a web page or New Tab, not in use by another agent), else a new tab.
   */
  function claimAgentTab(sessionId: string): string {
    const isLive = (id: string | undefined): id is string =>
      !!id && tabsRef.current.some(t => t.id === id) && !closingIdsRef.current.has(id);
    const busy = tabsBusyWithOtherAgents(sessionId);
    const previous = agentTabBySessionRef.current.get(sessionId);
    if (isLive(previous) && !busy.has(previous)) return previous;
    const active = tabsRef.current.find(t => t.isActive && !closingIdsRef.current.has(t.id));
    const usable = active && !busy.has(active.id) && (isNewTabUrl(active.url) || !isInternalUrl(active.url));
    const tabId = usable ? active.id : addTab(NEW_TAB_URL);
    if (!usable) pendingAgentTabsRef.current.add(tabId);
    setAgentTab(sessionId, tabId);
    return tabId;
  }

  /** What main's agent for `sessionId` sees of its tab (see AgentTabSurface in agent.ts). */
  function agentTabSurface(sessionId: string) {
    const tabId = agentTabBySessionRef.current.get(sessionId) ?? claimAgentTab(sessionId);
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return pendingAgentTabsRef.current.has(tabId) ? null : { mode: 'closed' };
    pendingAgentTabsRef.current.delete(tabId);
    if (closingIdsRef.current.has(tab.id)) return { mode: 'closed' };
    if (isNewTabUrl(tab.url) && tab.isActive) {
      const shell = document.querySelector(`.new-tab-shell[data-tab-id="${tab.id}"]`);
      if (shell) {
        const r = shell.getBoundingClientRect();
        return { mode: 'renderer', x: r.left, y: r.top, w: r.width, h: r.height };
      }
    }
    if (isInternalUrl(tab.url)) return { mode: 'internal', url: tab.url };
    const el = webviewRefs.current.get(tab.id);
    if (!el) return null; // not mounted yet
    const r = el.getBoundingClientRect();
    return {
      mode: 'webview',
      wcId: getWebContentsIdForTab(tab.id),
      x: r.left, y: r.top, w: r.width, h: r.height,
      // On screen: the agent can use real input. Otherwise it works in the background.
      visible: tab.isActive && document.visibilityState === 'visible',
    };
  }

  // The API main uses to drive each agent's tab (callAgentTabs in main.ts). Reassigned
  // every render so it always uses current state.
  useEffect(() => {
    const normalize = (u: string) => u.replace(/\/$/, "");
    (window as any).__agentTabs = {
      surface: agentTabSurface,
      openTab: (sessionId: string, url: string) => {
        const current = agentTabBySessionRef.current.get(sessionId);
        // Follow along on screen only if you're looking at this agent's tab.
        const foreground = !!tabsRef.current.find(t => t.id === current)?.isActive;
        const tabId = addTab(url, { background: !foreground, openerId: current });
        pendingAgentTabsRef.current.add(tabId);
        setAgentTab(sessionId, tabId);
        return tabId;
      },
      navigate: (sessionId: string, url: string) => {
        const tabId = agentTabBySessionRef.current.get(sessionId) ?? claimAgentTab(sessionId);
        if (url === 'back') goBackInTab(tabId);
        else navigateTabToUrl(tabId, url);
      },
      switchToTab: (sessionId: string, url: string) => {
        const busy = tabsBusyWithOtherAgents(sessionId);
        const target = tabsRef.current.find(t => !closingIdsRef.current.has(t.id) && !busy.has(t.id) && normalize(t.url) === normalize(url));
        if (!target) return false;
        const current = agentTabBySessionRef.current.get(sessionId);
        const foreground = !!tabsRef.current.find(t => t.id === current)?.isActive;
        setAgentTab(sessionId, target.id);
        if (foreground && !target.isActive) activateTab(target.id);
        return true;
      },
      listTabs: (sessionId: string) => {
        const own = agentTabBySessionRef.current.get(sessionId);
        return tabsRef.current
          .filter(t => !closingIdsRef.current.has(t.id))
          .map(t => ({ id: t.id, url: t.url, title: t.title, isActive: t.isActive, isAgentTab: t.id === own }));
      },
    };
  });

  /** Tabs some running agent is working in (they stay rendered while hidden, see the <webview> style). */
  const agentWorkingTabIds = new Set(
    Object.keys(runningAgents).map(sessionId => agentTabBySession[sessionId]).filter((id): id is string => !!id)
  );

  /** Applies `update` to a conversation's messages: live if it's the open one, else in its saved session. */
  function updateSessionMessages(sessionId: string, update: (messages: ChatMessage[]) => ChatMessage[]) {
    if (sessionId === currentSessionIdRef.current) {
      setChatMessages(update);
    } else {
      setSidebarSessions(prev => prev.map(s => s.id === sessionId ? { ...s, messages: update(s.messages), updatedAt: Date.now() } : s));
    }
  }
  const [expandedAgentGroups, setExpandedAgentGroups] = useState<Set<number>>(new Set());

  function toggleAgentGroup(startIndex: number) {
    setExpandedAgentGroups((prev) => {
      const next = new Set(prev);
      if (next.has(startIndex)) {
        next.delete(startIndex);
      } else {
        next.add(startIndex);
      }
      return next;
    });
  }

  // Sidebar resizing state
  const [sidebarWidth, setSidebarWidth] = useState(350);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        const newWidth = window.innerWidth - e.clientX;
        // Clamp width between 250px and 800px
        if (newWidth > 250 && newWidth < 800) {
          setSidebarWidth(newWidth);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
    };

    if (isResizingSidebar) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
    } else {
      document.body.style.cursor = '';
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
    };
  }, [isResizingSidebar]);

  const handleInputResize = () => {
    if (textareaRef.current) {
      const MAX_HEIGHT = 200;
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.min(textareaRef.current.scrollHeight, MAX_HEIGHT);
      textareaRef.current.style.height = `${newHeight}px`;
      textareaRef.current.style.overflowY = textareaRef.current.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
    }
  };

  async function getActivePageContextMessage(): Promise<{ role: 'system'; content: string } | null> {
    const activeTab = tabsRef.current.find((tab) => tab.isActive);
    if (!activeTab || isInternalUrl(activeTab.url)) return null;

    const webview = getActiveWebview();
    if (!webview) return null;

    try {
      const text: string = await webview.executeJavaScript("document.body ? document.body.innerText : ''");
      if (!text) return null;
      const truncated = text.slice(0, 6000);
      return {
        role: 'system',
        content: `The user is currently viewing "${activeTab.title || activeTab.url}" (${activeTab.url}). Page content:\n${truncated}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * The conversation as the chat model should see it. Built from everything in the session, so
   * what the agent did (its steps, answer or warning) is known after switching back to chat.
   */
  function buildChatPayloadHistory(messages: ChatMessage[], latest: string): { role: 'user' | 'assistant'; content: string }[] {
    const clip = (text: string, max: number) => {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    };
    const out: { role: 'user' | 'assistant'; content: string }[] = [];
    const push = (role: 'user' | 'assistant', content: string) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content += `\n${content}`;
      else out.push({ role, content });
    };
    let steps: string[] = [];
    let agentRan = false;
    const flushSteps = () => {
      if (steps.length === 0) return;
      const shown = steps.slice(-8).map(s => clip(s, 160));
      const label = steps.length > shown.length ? `last ${shown.length} of ${steps.length} steps` : 'steps';
      push('assistant', `[Browser agent actions taken (${label}): ${shown.join(' → ')}]`);
      steps = [];
    };
    for (const m of messages) {
      if (m.role === 'agent') { steps.push(m.text); agentRan = true; continue; }
      if (m.role === 'user') { flushSteps(); agentRan = false; push('user', m.text); continue; }
      if (m.role === 'reply') {
        flushSteps();
        push('assistant', agentRan ? `[Browser agent finished and answered]: ${m.text}` : m.text);
        agentRan = false;
        continue;
      }
      if (m.role === 'warning' && agentRan) { flushSteps(); push('assistant', `[Browser agent stopped with a warning]: ${clip(m.text, 600)}`); }
    }
    flushSteps();
    push('user', latest);
    return out;
  }

  async function requestChatReply(history: { role: 'user' | 'assistant'; content: string }[], imageUrl?: string) {
    setIsChatLoading(true);
    try {
      const pageContext = await getActivePageContextMessage();
      const payloadMessages = [...(pageContext ? [pageContext] : []), ...history];

      let accumulated = "";
      const result = await window.api?.chatStreamRequest(
        { agentRole: "conversant", messages: payloadMessages, ...(imageUrl ? { imageUrl } : {}) },
        (delta: string) => {
          accumulated += delta;
          setIsChatLoading(false);
          setChatStreamingReply(accumulated);
        }
      );

      if (result && !result.error) {
        const replyText = accumulated || (typeof result.data?.reply === "string" ? result.data.reply : "");
        if (replyText) {
          setChatMessages(prev => [...prev, { role: 'reply', text: replyText }]);
          setChatHistory(prev => [...prev, { role: 'assistant', content: replyText }]);
        }
      } else {
        setChatMessages(prev => [...prev, { role: 'warning', text: `Chat error: ${result?.text || "unknown error"}` }]);
      }
    } catch (error) {
      setChatMessages(prev => [...prev, { role: 'warning', text: `Network error: ${String(error)}` }]);
    } finally {
      setChatStreamingReply(null);
      setIsChatLoading(false);
    }
  }

  /**
   * Hands a task to the agent. `chatTabHistory` is the conversation from the full-page
   * Chat tab when the task comes from there; otherwise the sidebar conversation is used.
   */
  function startAgentRun(taskText: string, chatTabHistory?: { role: 'user' | 'assistant'; content: string }[]) {
    // The agent drives the regular window; main ignores requests from incognito ones.
    if (IS_INCOGNITO) return;
    const history: ChatMessage[] = chatTabHistory
      ? chatTabHistory.map(m => ({ role: m.role === 'user' ? 'user' : 'reply', text: m.content }))
      : chatMessages;
    // A task from the Chat tab isn't in this conversation yet, so show it before the switch.
    const handoff: ChatMessage[] = [...(chatTabHistory ? [{ role: 'user' as const, text: taskText }] : []), { role: 'mode', text: 'agent' }];

    taskSuggestion.clear();
    setShowAssistant(true);
    // Auto mode already runs tasks itself, so it stays in Auto; a chat continues as an agent conversation.
    if (assistantMode === 'chat') {
      handedOffSessionsRef.current.add(currentSessionIdRef.current);
      setAssistantMode('agent');
    }
    setChatMessages(prev => [...prev, ...handoff]);
    // The whole conversation (including the chat that led here) and its notepad go along.
    launchAgent(taskText, history);
  }

  /**
   * Starts the open conversation's agent on `text`. It works in its own tab (a chat or
   * history page can't be used, so it gets a new tab then), and keeps running if you
   * switch conversations or tabs.
   */
  function launchAgent(text: string, history: ChatMessage[]) {
    const sessionId = currentSessionIdRef.current;
    claimAgentTab(sessionId);
    setAgentRunState(sessionId, { paused: false });
    const agentHistory = history.filter((m): m is AgentHistoryMessage => m.role !== 'mode');
    window.api?.runAgentInstruction({ sessionId, text, history: agentHistory, notes: agentNotes });
  }

  /** Whether the conversation's last answer came from the agent or from chat; null if nothing has answered yet. */
  function lastRoute(messages: ChatMessage[]): 'agent' | 'chat' | null {
    let sawReply = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const { role, text } = messages[i];
      if (role === 'mode') return text === 'agent' ? 'agent' : 'chat';
      if (role === 'agent') return 'agent';
      if (role === 'reply') sawReply = true;
      // A reply with no agent steps between it and its user message was a chat reply.
      else if (role === 'user' && sawReply) return 'chat';
    }
    return sawReply ? 'chat' : null;
  }

  /**
   * Called when a conversation's agent run ends. In Auto (and in a Chat conversation that
   * was handed to the agent) the conversation goes back to chat, which is marked in it.
   */
  function returnToChat(sessionId: string) {
    const isOpen = sessionId === currentSessionIdRef.current;
    const handedOff = handedOffSessionsRef.current.delete(sessionId);
    const mode = isOpen ? assistantModeRef.current : sidebarSessionsRef.current.find(s => s.id === sessionId)?.mode;
    if (!handedOff && mode !== 'auto') return;
    updateSessionMessages(sessionId, prev => {
      const last = prev[prev.length - 1];
      return last?.role === 'mode' && last.text === 'chat' ? prev : [...prev, { role: 'mode', text: 'chat' }];
    });
    if (!handedOff) return;
    if (isOpen) setAssistantMode('chat');
    else setSidebarSessions(prev => prev.map(s => s.id === sessionId ? { ...s, mode: 'chat' } : s));
  }

  /** A switch marker if a message going to `route` changes sides from the conversation so far (`messages`). */
  function routeSwitchNotice(route: 'agent' | 'chat', messages: ChatMessage[]): ChatMessage[] {
    // A new conversation starts on its mode's side (Auto starts as chat).
    const previous = lastRoute(messages) ?? (assistantMode === 'agent' ? 'agent' : 'chat');
    return previous === route ? [] : [{ role: 'mode', text: route }];
  }

  async function handleAgentSend() {
    const text = chatInput.trim();
    if (!text) return;
    if (assistantMode !== 'agent' && isChatLoading) return;

    setChatInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // In Auto, a message sent while this conversation's agent is running is a follow-up for it.
    if (assistantMode === 'agent' || (assistantMode === 'auto' && isAgentRunning)) {
      setChatMessages(prev => [...prev, { role: 'user', text }, ...routeSwitchNotice('agent', chatMessages)]);
      // Send the conversation so far and its notepad, so a follow-up like "I meant
      // wired earphones" is read against the earlier request rather than on its own.
      launchAgent(text, chatMessages);
      return;
    }

    const attachedImage = imageAttachment.pendingImage;
    imageAttachment.clear();
    taskSuggestion.clear();
    setChatMessages(prev => [...prev, { role: 'user', text }]);

    if (assistantMode === 'auto') {
      // The agent can't use an attached image, so a message with one is always chat.
      const sessionId = currentSessionIdRef.current;
      setIsChatLoading(true);
      const isTask = !attachedImage && await classifyAsTask(text);
      if (sessionId !== currentSessionIdRef.current) {
        // You switched conversations while Jev was deciding; don't act in the new one.
        setIsChatLoading(false);
        return;
      }
      const notice = routeSwitchNotice(isTask ? 'agent' : 'chat', chatMessages);
      if (notice.length) setChatMessages(prev => [...prev, ...notice]);
      if (isTask) {
        setIsChatLoading(false);
        launchAgent(text, chatMessages);
        return;
      }
      // Agent runs add to this conversation too, so chat replies are built from all of it
      // (chatHistory only has the chat turns).
      setChatHistory(prev => [...prev, { role: 'user', content: text }]);
      await requestChatReply(buildChatPayloadHistory(chatMessages, text), attachedImage?.dataUrl);
      return;
    }

    // Chat mode
    const notice = routeSwitchNotice('chat', chatMessages);
    if (notice.length) setChatMessages(prev => [...prev, ...notice]);
    setChatHistory([...chatHistory, { role: 'user' as const, content: text }]);

    // Built from the whole conversation, so anything the agent did earlier is part of it.
    await requestChatReply(buildChatPayloadHistory(chatMessages, text), attachedImage?.dataUrl);
    taskSuggestion.suggest(text);
  }

  // Stop / pause / resume act on the open conversation's agent only.
  function handleAgentStop() {
    window.api?.stopAgent(currentSessionId);
    setAgentRunState(currentSessionId, null);
    returnToChat(currentSessionId);
    setAgentCursor(null);
  }

  function handleAgentPause() {
    window.api?.pauseAgent(currentSessionId);
    setAgentRunState(currentSessionId, { paused: true });
  }

  function handleAgentResume() {
    window.api?.resumeAgent(currentSessionId);
    setAgentRunState(currentSessionId, { paused: false });
  }

  useEffect(() => {
    const cleanup = window.api?.onAgentCursorFlash((_event: any, sessionId: string, pos: { x: number; y: number }) => {
      // Only meaningful over the tab you're looking at.
      const tabId = agentTabBySessionRef.current.get(sessionId);
      if (tabsRef.current.find(t => t.id === tabId)?.isActive) setAgentCursor({ x: pos.x, y: pos.y });
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentAction((_event: any, sessionId: string, description: string) => {
      updateSessionMessages(sessionId, prev => [...prev, { role: 'agent', text: description }]);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentDone((_event: any, sessionId: string, answer: string) => {
      setAgentRunState(sessionId, null);
      if (sessionId === currentSessionIdRef.current) setAgentCursor(null);
      if (answer && answer.trim()) {
        updateSessionMessages(sessionId, prev => [...prev, { role: 'reply', text: answer.trim() }]);
      }
      returnToChat(sessionId);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentWarn((_event: any, sessionId: string, message: string) => {
      if (message && message.trim()) {
        updateSessionMessages(sessionId, prev => [...prev, { role: 'warning', text: message.trim() }]);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentTip((_event: any, sessionId: string, tip: { id: string; auto: boolean; description: string; text: string }) => {
      if (sessionId !== currentSessionIdRef.current) return;
      setReceivedTips(prev => [...prev.filter(t => t.id !== tip.id), tip]);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = window.api?.onAgentNotes((_event: any, sessionId: string, notes: string) => {
      if (sessionId !== currentSessionIdRef.current) {
        setSidebarSessions(prev => prev.map(s => s.id === sessionId ? { ...s, agentNotes: notes } : s));
        return;
      }
      setAgentNotes(notes);
      if (notes) {
        setNotepadFlash(true);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => setNotepadFlash(false), 1200);
      }
    });
    return () => {
      clearTimeout(flashTimer);
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentSupervisor((_event: any, sessionId: string, info: { count: number; limit: number; task: string; refinedPrompt: string | null }) => {
      const text = info.refinedPrompt
        ? `Noticed repeated actions (${info.count}/${info.limit}) — adjusting approach: "${info.refinedPrompt}"`
        : `Noticed repeated actions (${info.count}/${info.limit}) on: "${info.task}"`;
      updateSessionMessages(sessionId, prev => [...prev, { role: 'supervisor', text }]);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanupDelay = window.api?.onAgentStepDelay((_event: any, sessionId: string, delay: { ms: number; reason?: string; isDefault?: boolean } | null) => {
      setStepDelays(prev => {
        const { [sessionId]: _old, ...rest } = prev;
        return delay ? { ...rest, [sessionId]: delay } : rest;
      });
    });
    const cleanupWait = window.api?.onAgentStepWait((_event: any, sessionId: string, wait: { ms: number }) => {
      const waitUntil = Date.now() + wait.ms;
      setStepDelayNow(Date.now());
      setStepDelays(prev => prev[sessionId] ? { ...prev, [sessionId]: { ...prev[sessionId], waitUntil } } : prev);
    });
    return () => {
      cleanupDelay?.();
      cleanupWait?.();
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const liveTabCount = tabs.length - closingIds.size;

  useEffect(() => {
    const calculateTabWidth = () => {
      const windowWidth = window.innerWidth;
      let reservedSpace = 0;

      // Padding
      reservedSpace += 20;

      // New tab button
      reservedSpace += 32;

      // Platform specific controls
      if (platform === 'darwin') {
        reservedSpace += 80;
      } else if (platform === 'win32') {
        reservedSpace += 150;
      }

      // Extra safety buffer
      reservedSpace += 20;

      // Gaps between tabs
      const totalGaps = Math.max(0, liveTabCount - 1) * TAB_GAP;

      const availableWidth = windowWidth - reservedSpace - totalGaps;

      if (liveTabCount > 0) {
        const widthPerTab = availableWidth / liveTabCount;
        // Clamp: Max 240px, Min 24px (enough to always keep the favicon visible)
        setTabWidth(Math.min(240, Math.max(24, widthPerTab)));
      }
    };

    calculateTabWidth();
    window.addEventListener('resize', calculateTabWidth);
    return () => window.removeEventListener('resize', calculateTabWidth);
  }, [liveTabCount, platform]);

  const effectiveTabWidth = frozenTabWidth ?? tabWidth;

  useEffect(() => {
    // Detect platform
    const userAgent = window.navigator.userAgent.toLowerCase();
    if (userAgent.indexOf('mac') !== -1) {
      setPlatform('darwin');
    } else if (userAgent.indexOf('linux') !== -1) {
      setPlatform('linux');
    } else {
      setPlatform('win32');
    }
  }, []);

  function getActiveWebview(): any {
    const activeTab = tabsRef.current.find((tab) => tab.isActive);
    if (!activeTab) return null;
    return webviewRefs.current.get(activeTab.id) ?? null;
  }

  function handleReloadActiveTab(ignoreCache = false) {
    const activeTab = tabsRef.current.find((tab) => tab.isActive);
    const activeWebview = getActiveWebview();
    if (!activeTab || !activeWebview) return;
    // A failed load never committed, so reload() would re-run the previous page.
    const error = tabRuntime[activeTab.id]?.error;
    if (error?.kind === "load") {
      patchRuntime(activeTab.id, { error: undefined });
      activeWebview.loadURL(error.url);
      return;
    }
    if (ignoreCache) activeWebview.reloadIgnoringCache();
    else activeWebview.reload();
  }

  function handleStopActiveTab() {
    getActiveWebview()?.stop();
  }

  // ---- Zoom ------------------------------------------------------------------
  // Chrome-style: Ctrl +/-/0 step through presets on the page's real (layout)
  // zoom; a bubble under the omnibox shows the level and offers −/+/Reset.
  const [zoomBubble, setZoomBubble] = useState<{ pinned: boolean; seq: number } | null>(null);
  const zoomBubbleHoverRef = useRef(false);

  function showZoomBubble(pinned = false) {
    setZoomBubble((prev) => ({ pinned: pinned || Boolean(prev?.pinned), seq: (prev?.seq ?? 0) + 1 }));
  }

  useEffect(() => {
    if (!zoomBubble || zoomBubble.pinned) return;
    const id = window.setTimeout(() => {
      if (!zoomBubbleHoverRef.current) setZoomBubble(null);
    }, 1800);
    return () => window.clearTimeout(id);
  }, [zoomBubble]);

  function applyPinchView(tabId: string, view: PinchView) {
    const el = webviewRefs.current.get(tabId) as any;
    const wasZoomed = (pinchScaleRef.current.get(tabId)?.scale ?? 1) > 1;
    pinchScaleRef.current.set(tabId, view);
    if (el) {
      el.style.transformOrigin = "0 0";
      el.style.transform = view.scale === 1 ? "" : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }
    patchRuntime(tabId, { pinch: view.scale });
    const zoomed = view.scale > 1;
    if (zoomed !== wasZoomed) {
      const wcId = getWebContentsIdForTab(tabId);
      if (wcId != null) window.api?.setPinchZoomed?.(wcId, zoomed);
    }
  }

  function resetPinchScale(tabId: string) {
    applyPinchView(tabId, PINCH_IDENTITY);
  }

  function changeActiveZoom(direction: 1 | -1 | 0, opts: { pinned?: boolean } = {}) {
    const tab = tabsRef.current.find((t) => t.isActive);
    if (!tab || isInternalUrl(tab.url)) return;
    const el = webviewRefs.current.get(tab.id) as any;
    if (!el) return;
    let current: number;
    try {
      current = el.getZoomFactor();
    } catch {
      return;
    }
    if (direction === 0) {
      resetPinchScale(tab.id);
      el.setZoomFactor(1);
    } else {
      el.setZoomFactor(nextZoomStep(current, direction));
    }
    // Chromium zoom is per-site, so other tabs on the same site may have changed too.
    tabsRef.current.forEach((t) => syncZoomFromPage(t.id));
    showZoomBubble(opts.pinned);
  }

  useEffect(() => {
    // `point` is the cursor in the guest's own untransformed coordinates. Zooming
    // keeps that page point under the cursor, so you zoom into where you point.
    const cleanup = window.api?.onPinchZoom((direction, point) => {
      const activeTab = tabsRef.current.find((tab) => tab.isActive);
      const el = activeTab ? (webviewRefs.current.get(activeTab.id) as HTMLElement | undefined) : undefined;
      if (!el || !activeTab) return;

      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const view = pinchScaleRef.current.get(activeTab.id) ?? PINCH_IDENTITY;
      const scale = Math.max(1, Math.min(4, view.scale * (direction === "in" ? 1.08 : 1 / 1.08)));
      const qx = point?.x ?? width / 2;
      const qy = point?.y ?? height / 2;
      applyPinchView(
        activeTab.id,
        clampPinchView(
          { scale, x: view.x + (view.scale - scale) * qx, y: view.y + (view.scale - scale) * qy },
          width,
          height,
        ),
      );
      showZoomBubble();
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    // While pinch-zoomed, the guest's own wheel scrolling is suppressed (in main)
    // and the deltas arrive here: pan the zoomed view first, and once it hits an
    // edge, scroll the page itself with whatever is left over.
    const cleanup = window.api?.onPinchPan(({ webContentsId, dx, dy }) => {
      const tab = findTabByWebContentsId(webContentsId);
      const el = tab ? (webviewRefs.current.get(tab.id) as any) : undefined;
      const view = tab ? pinchScaleRef.current.get(tab.id) : undefined;
      if (!tab || !el || !view || view.scale <= 1) return;

      // Chromium wheel deltas are positive when scrolling up/left, i.e. the
      // direction the content should move on screen.
      const wanted = { scale: view.scale, x: view.x + dx, y: view.y + dy };
      const next = clampPinchView(wanted, el.offsetWidth, el.offsetHeight);
      applyPinchView(tab.id, next);

      const restX = wanted.x - next.x;
      const restY = wanted.y - next.y;
      if (Math.abs(restX) >= 0.5 || Math.abs(restY) >= 0.5) {
        el.executeJavaScript(`window.scrollBy(${-restX / view.scale}, ${-restY / view.scale})`).catch(() => {});
      }
    });
    return () => cleanup?.();
  }, []);

  // ---- Window controls ---------------------------------------------------------
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    window.api?.isWindowMaximized?.().then(setIsMaximized).catch(() => {});
    const cleanup = window.api?.onWindowMaximized(setIsMaximized);
    return () => cleanup?.();
  }, []);

  function handleMinimize() {
    if (window.api?.minimizeWindow) {
      window.api!.minimizeWindow();
    }
  }

  function handleMaximize() {
    if (window.api?.maximizeWindow) {
      window.api!.maximizeWindow();
    }
  }

  function handleClose() {
    if (window.api?.closeWindow) {
      window.api!.closeWindow();
    }
  }

  // ---- Address bar (omnibox) ---------------------------------------------------
  const [AddressBarValue, setAddressBarValue] = useState("");
  const addressBarFocusedRef = useRef(false);
  const [addressFocused, setAddressFocused] = useState(false);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const selectAllOnFocusRef = useRef(false);
  // What the user actually typed, restored when arrowing back out of the suggestions.
  const typedAddressRef = useRef("");
  const skipRevertOnBlurRef = useRef(false);
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  // Greyed-out inline completion shown after the typed text; Tab accepts it.
  const [ghostSuffix, setGhostSuffix] = useState("");

  useEffect(() => {
    if (addressBarFocusedRef.current) {
      return;
    }

    const activeTab = tabs.find(t => t.isActive);
    if (activeTab) {
      if (isNewTabUrl(activeTab.url)) {
        setAddressBarValue("");
      } else {
        setAddressBarValue(activeTab.url);
      }
    }
  }, [tabs]);

  function activeTabAddress() {
    const activeTab = tabsRef.current.find((t) => t.isActive);
    return !activeTab || isNewTabUrl(activeTab.url) ? "" : activeTab.url;
  }

  function focusAddressBar(selectAll: boolean) {
    const input = addressInputRef.current;
    if (!input) return;
    if (document.activeElement === input) {
      if (selectAll) input.select();
      return;
    }
    selectAllOnFocusRef.current = selectAll;
    input.focus();
  }

  // Selection has to be applied after React swaps the elided display URL for
  // the full one, or it's lost when the value changes.
  useLayoutEffect(() => {
    if (addressFocused && selectAllOnFocusRef.current) {
      selectAllOnFocusRef.current = false;
      addressInputRef.current?.select();
    }
  }, [addressFocused]);

  /** Remainder of the best history match for `typed` ("git" -> "hub.com"), or "". */
  function ghostCompletion(typed: string): string {
    const lower = typed.toLowerCase();
    if (!lower || /\s/.test(lower)) return "";
    for (const entry of history) {
      const display = formatDisplayUrl(entry.url);
      if (!display.toLowerCase().startsWith(lower)) continue;
      const boundary = display.indexOf("/", lower.length);
      const rest = display.slice(typed.length, boundary === -1 ? undefined : boundary);
      if (rest) return rest;
    }
    return "";
  }

  function computeSuggestions(typed: string): OmniboxSuggestion[] {
    const query = typed.trim();
    if (!query) return [];
    const lower = query.toLowerCase();
    const out: OmniboxSuggestion[] = [];

    if (looksLikeUrl(query)) {
      out.push({ kind: "url", label: formatDisplayUrl(toNavigableUrl(query)!), url: toNavigableUrl(query)! });
    } else {
      out.push({ kind: "search", label: query, detail: searchEngineLabel(), url: webSearchUrl(query) });
    }

    const seen = new Set(out.map((s) => s.url));

    tabsRef.current
      .filter((t) => !t.isActive && !isInternalUrl(t.url) && !closingIdsRef.current.has(t.id))
      .filter((t) => (t.title ?? "").toLowerCase().includes(lower) || formatDisplayUrl(t.url).toLowerCase().includes(lower))
      .slice(0, 2)
      .forEach((t) => {
        out.push({ kind: "tab", label: t.title || formatDisplayUrl(t.url), detail: "Switch to this tab", url: t.url, tabId: t.id });
        seen.add(t.url);
      });

    const scored: { entry: HistoryEntry; score: number }[] = [];
    for (const entry of history) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      const display = formatDisplayUrl(entry.url).toLowerCase();
      const title = (entry.title ?? "").toLowerCase();
      const score = display.startsWith(lower) ? 3 : display.includes(lower) ? 2 : title.includes(lower) ? 1 : 0;
      if (score) scored.push({ entry, score });
      if (scored.length >= 60) break;
    }
    scored
      .sort((a, b) => b.score - a.score) // stable: keeps recency order within a score
      .slice(0, 5)
      .forEach(({ entry }) =>
        out.push({
          kind: "history",
          label: entry.title && entry.title !== entry.url ? entry.title : formatDisplayUrl(entry.url),
          detail: formatDisplayUrl(entry.url),
          url: entry.url,
        })
      );

    if (out[0].kind === "url" && !/[/:]/.test(query)) {
      out.push({ kind: "search", label: query, detail: searchEngineLabel(), url: webSearchUrl(query) });
    }
    return out.slice(0, 8);
  }

  function handleAddressChange(e: ChangeEvent<HTMLInputElement>) {
    const typed = e.target.value;
    typedAddressRef.current = typed;
    // Suggestions only appear in the dropdown; the input keeps exactly what was typed.
    setAddressBarValue(typed);
    const inputType = (e.nativeEvent as InputEvent).inputType ?? "";
    const atEnd = e.target.selectionStart === typed.length;
    setGhostSuffix(!inputType.startsWith("delete") && atEnd ? ghostCompletion(typed) : "");
    setSuggestions(computeSuggestions(typed));
    setSelectedSuggestion(-1);
  }

  function commitAddress(suggestion: OmniboxSuggestion | null, rawValue: string, inNewTab = false) {
    setSuggestions([]);
    setSelectedSuggestion(-1);

    if (suggestion?.kind === "tab" && suggestion.tabId) {
      skipRevertOnBlurRef.current = false;
      addressInputRef.current?.blur();
      activateTab(suggestion.tabId);
      return;
    }

    const url = suggestion ? suggestion.url : toNavigableUrl(rawValue);
    if (!url) return;
    skipRevertOnBlurRef.current = true;
    addressInputRef.current?.blur();

    if (inNewTab) {
      setAddressBarValue(activeTabAddress());
      addTab(url);
      return;
    }

    const activeTab = tabsRef.current.find((tab) => tab.isActive);
    if (activeTab && activeTab.url === url && !isInternalUrl(url)) {
      setAddressBarValue(url);
      handleReloadActiveTab();
      return;
    }

    navigateActiveTabToUrl(url);
  }

  function handleAddressKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const caretAtEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    if (ghostSuffix && selectedSuggestion === -1 && !e.shiftKey && (e.key === "Tab" || ((e.key === "ArrowRight" || e.key === "End") && caretAtEnd))) {
      e.preventDefault();
      const accepted = input.value + ghostSuffix;
      typedAddressRef.current = accepted;
      setAddressBarValue(accepted);
      setGhostSuffix("");
      setSuggestions(computeSuggestions(accepted));
      return;
    }
    if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") {
      // Anything else that moves the caret or picks a suggestion drops the hint.
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Escape" || e.key === "Enter" || e.key === "ArrowLeft" || e.key === "Home") setGhostSuffix("");
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      e.preventDefault();
      let next = selectedSuggestion + (e.key === "ArrowDown" ? 1 : -1);
      if (next < -1) next = suggestions.length - 1;
      if (next >= suggestions.length) next = -1;
      setSelectedSuggestion(next);
      const s = suggestions[next];
      setAddressBarValue(next === -1 ? typedAddressRef.current : s.kind === "search" ? s.label : s.url);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      commitAddress(selectedSuggestion >= 0 ? suggestions[selectedSuggestion] : null, e.currentTarget.value, e.altKey);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      const input = e.currentTarget;
      const original = activeTabAddress();
      if (suggestions.length > 0 || input.value !== original) {
        // First Escape: throw away the edit (like Chrome) and select the URL.
        setSuggestions([]);
        setSelectedSuggestion(-1);
        setAddressBarValue(original);
        window.requestAnimationFrame(() => input.select());
      } else {
        input.blur();
        const activeTab = tabsRef.current.find((t) => t.isActive);
        if (activeTab && !isNewTabUrl(activeTab.url)) focusTabContent(activeTab.id);
      }
    }
  }
  function navigateActiveTabToUrl(url: string) {
    const targetTabId = activeTabId ?? tabsRef.current.find(tab => tab.isActive)?.id;
    if (!targetTabId) return;
    navigateTabToUrl(targetTabId, url);
  }

  /** Loads `url` in a tab (adding a history entry); the address bar follows only if it's the active tab. */
  function navigateTabToUrl(targetTabId: string, url: string) {
    const isNewTab = isNewTabUrl(url);
    if (!isInternalUrl(url)) pendingNavRef.current.add(targetTabId);
    if (tabsRef.current.find(tab => tab.id === targetTabId)?.isActive) setAddressBarValue(isNewTab ? "" : url);
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id !== targetTabId
          ? tab
          : (() => {
              const history = tab.history?.length ? tab.history : [tab.url];
              const nextHistory = history.slice(0, Math.max(0, tab.historyIndex + 1));
              if (nextHistory[nextHistory.length - 1] !== url) {
                nextHistory.push(url);
              }

              return {
                ...tab,
                url,
                isLoading: !isInternalUrl(url),
                faviconUrl: isInternalUrl(url) ? null : guessFaviconUrl(url),
                history: nextHistory,
                historyIndex: nextHistory.length - 1,
              };
            })()
      )
    );
  }

  // Lets the new tab page fade out before it is swapped for the destination.
  async function playNewTabExit() {
    setNewTabLeaving(true);
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    setNewTabLeaving(false);
  }

  async function handleNewTabSearch(query: string) {
    setNewTabRoutingError(null);
    // Incognito skips the AI router, which would send the query to the backend.
    if (IS_INCOGNITO) {
      navigateActiveTabToUrl(looksLikeUrl(query) ? toNavigableUrl(query) ?? webSearchUrl(query) : webSearchUrl(query));
      return;
    }
    try {
      const searchRouteRequest = window.api?.searchRouteRequest?.(query);
      if (!searchRouteRequest) {
        navigateActiveTabToUrl(webSearchUrl(query));
        return;
      }

      const response = await withTimeout<ApiResponse>(searchRouteRequest, 2000);
      const route = !response?.error ? parseSearchRoute(response?.data) : null;
      await playNewTabExit();

      if (route?.routing === "web-search") {
        navigateActiveTabToUrl(webSearchUrl(query));
        return;
      }

      const chatUrl = new URL("indus://chat");
      chatUrl.searchParams.set("q", query);
      if (route?.chatTitle?.trim()) {
        chatUrl.searchParams.set("title", route.chatTitle.trim());
      }
      navigateActiveTabToUrl(chatUrl.toString());
    } catch (error) {
      console.error("Search route failed", error);
      setNewTabRoutingError("Couldn't reach the AI router — showing a web search instead.");
      window.setTimeout(() => setNewTabRoutingError(null), 4000);
      navigateActiveTabToUrl(webSearchUrl(query));
    }
  }

  function setTabTitle(tabId: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setTabs((currentTabs) => {
      const target = currentTabs.find((tab) => tab.id === tabId);
      if (!target || target.title === nextTitle) {
        return currentTabs;
      }
      return currentTabs.map((tab) =>
        tab.id === tabId ? { ...tab, title: nextTitle } : tab
      );
    });
  }

  function webviewSrcFor(tab: Tab) {
    const initial = webviewInitialSrcRef.current.get(tab.id);
    if (initial !== undefined) return initial;
    webviewInitialSrcRef.current.set(tab.id, tab.url);
    return tab.url;
  }

  useEffect(() => {
    tabs.forEach((tab) => {
      if (isInternalUrl(tab.url)) {
        // Its webview unmounts; a later remount must start from the new URL.
        webviewInitialSrcRef.current.delete(tab.id);
        webviewKnownUrlRef.current.delete(tab.id);
        return;
      }
      const el = webviewRefs.current.get(tab.id) as any;
      if (!el) return;
      const known = webviewKnownUrlRef.current.get(tab.id);
      webviewKnownUrlRef.current.set(tab.id, known ?? tab.url);
      if (known === undefined || known === tab.url) return;
      webviewKnownUrlRef.current.set(tab.id, tab.url);
      try {
        el.loadURL(tab.url).catch(() => {});
      } catch {
        // Not dom-ready yet; the src attribute works at any point.
        el.setAttribute("src", tab.url);
      }
    });
  }, [tabs]);

  function updateTabUrl(tabId: string, newUrl: string, replaceCurrent = false, fromWebview = false) {
    if (fromWebview) webviewKnownUrlRef.current.set(tabId, newUrl);
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id !== tabId
          ? tab
          : (() => {
              const history = tab.history?.length ? tab.history : [tab.url];
              const currentIndex = Math.min(tab.historyIndex, history.length - 1);
              const currentHistoryUrl = history[currentIndex];

              if (currentHistoryUrl === newUrl) {
                return {
                  ...tab,
                  url: newUrl,
                  faviconUrl: currentHistoryUrl === tab.url ? tab.faviconUrl ?? null : null,
                };
              }

              if (replaceCurrent) {
                // Redirect: keep the entry count and forward history intact.
                const replaced = history.slice();
                replaced[currentIndex] = newUrl;
                return {
                  ...tab,
                  url: newUrl,
                  faviconUrl: isInternalUrl(newUrl) ? null : guessFaviconUrl(newUrl),
                  history: replaced,
                  historyIndex: currentIndex,
                };
              }

              const nextHistory = history.slice(0, Math.max(0, tab.historyIndex + 1));
              nextHistory.push(newUrl);

              return {
                ...tab,
                url: newUrl,
                faviconUrl: isInternalUrl(newUrl) ? null : guessFaviconUrl(newUrl),
                history: nextHistory,
                historyIndex: nextHistory.length - 1,
              };
            })()
      )
    );
    const activeTab = tabsRef.current.find(t => t.isActive);
    if (activeTab && activeTab.id === tabId) {
      if (!addressBarFocusedRef.current) {
        setAddressBarValue(isNewTabUrl(newUrl) ? "" : newUrl);
      }
    }
  }

  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  useEffect(() => {
    const activeTab = tabs.find(tab => tab.isActive);
    if (activeTab) {
      setActiveTabId(activeTab.id);
    } else {
      setActiveTabId(null);
    }
  }, [tabs]);


  function goBack() {
    const activeTab = tabsRef.current.find((tab) => tab.isActive);
    if (activeTab) goBackInTab(activeTab.id);
  }

  function goBackInTab(tabId: string) {
    const activeTab = tabsRef.current.find((tab) => tab.id === tabId);
    if (!activeTab || activeTab.historyIndex <= 0) return;

    const targetIndex = activeTab.historyIndex - 1;
    const targetUrl = activeTab.history[targetIndex];
    if (isInternalUrl(targetUrl)) pendingNavRef.current.delete(activeTab.id);
    else pendingNavRef.current.add(activeTab.id);

    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              url: targetUrl,
              historyIndex: targetIndex,
              isLoading: !isInternalUrl(targetUrl),
              faviconUrl: isInternalUrl(targetUrl) ? null : guessFaviconUrl(targetUrl),
            }
          : tab
      )
    );
  }

  function goForward() {
    const activeTab = tabsRef.current.find((tab) => tab.isActive);
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;

    const targetIndex = activeTab.historyIndex + 1;
    const targetUrl = activeTab.history[targetIndex];
    if (isInternalUrl(targetUrl)) pendingNavRef.current.delete(activeTab.id);
    else pendingNavRef.current.add(activeTab.id);

    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              url: targetUrl,
              historyIndex: targetIndex,
              isLoading: !isInternalUrl(targetUrl),
              faviconUrl: isInternalUrl(targetUrl) ? null : guessFaviconUrl(targetUrl),
            }
          : tab
      )
    );
  }


  useEffect(() => {
    const cleanup = window.api?.onAgentReloadActiveTab(() => {
      handleReloadActiveTab();
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    // Registered once, so read the active tab from the ref — the activeTabId
    // captured here would be null forever.
    const cleanup = window.api?.onAgentCloseActiveTab(() => {
      const activeTab = tabsRef.current.find((t) => t.isActive);
      if (activeTab) closeTab(activeTab.id);
    });
    return () => cleanup?.();
  }, []);

  // Handle new-tab requests from webview guests via main process.
  // Ctrl/middle-click ("background-tab") open behind the current tab, next to
  // the page that opened them — like Chrome.
  useEffect(() => {
    const cleanup = window.api?.onOpenUrlInNewTab((_event: any, url: string, info?: { disposition?: string; openerId?: number }) => {
      if (!url) return;
      const opener = info?.openerId != null ? findTabByWebContentsId(info.openerId) : undefined;
      // A page a running agent is driving opened a new tab (target="_blank", window.open):
      // the agent carries on in the new tab. It only comes to the front if you were
      // watching the agent's tab, so an agent working in the background never steals focus.
      const agentSession = opener && [...agentTabBySessionRef.current]
        .find(([sid, tabId]) => tabId === opener.id && runningAgentsRef.current[sid])?.[0];
      if (agentSession) {
        const tabId = addTab(url, { background: info?.disposition === "background-tab" || !opener.isActive, openerId: opener.id });
        pendingAgentTabsRef.current.add(tabId);
        setAgentTab(agentSession, tabId);
        return;
      }
      addTab(url, { background: info?.disposition === "background-tab", openerId: opener?.id });
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (IS_INCOGNITO) return;
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {
      // Ignore storage failures and keep the browser usable.
    }
  }, [history]);

  function closeFindBar() {
    const webview = getActiveWebview();
    webview?.stopFindInPage?.('clearSelection');
    setShowFindBar(false);
    setFindQuery("");
    setFindMatches(null);
  }

  function performFind(query: string, forward: boolean, findNext: boolean) {
    const webview = getActiveWebview();
    if (!webview) return;
    if (!query) {
      webview.stopFindInPage?.('clearSelection');
      setFindMatches(null);
      return;
    }
    webview.findInPage?.(query, { forward, findNext });
  }

  function openFindBar() {
    const activeTab = tabsRef.current.find((t) => t.isActive);
    if (!activeTab || isInternalUrl(activeTab.url)) return;
    setShowFindBar(true);
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  // ---- Popovers (site info, app menu) ------------------------------------------
  const [siteInfo, setSiteInfo] = useState<{ cookies: number | null; confirmClear: boolean; shields: ShieldsTabState | null } | null>(null);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const siteInfoRef = useRef<HTMLDivElement>(null);
  const appMenuRef = useRef<HTMLDivElement>(null);
  const zoomBubbleRef = useRef<HTMLDivElement>(null);

  useDismiss(siteInfo !== null, siteInfoRef, () => setSiteInfo(null));
  useDismiss(appMenuOpen, appMenuRef, () => setAppMenuOpen(false));
  useDismiss(Boolean(zoomBubble?.pinned), zoomBubbleRef, () => setZoomBubble(null));

  function openSiteInfo() {
    const activeTab = tabsRef.current.find((t) => t.isActive);
    if (!activeTab || isInternalUrl(activeTab.url)) return;
    setSiteInfo({ cookies: null, confirmClear: false, shields: null });
    window.api?.countCookiesForUrl(activeTab.url)
      .then((count) => setSiteInfo((prev) => (prev ? { ...prev, cookies: count } : prev)))
      .catch(() => {});
    const wcId = getWebContentsIdForTab(activeTab.id);
    if (wcId !== null) {
      window.api?.getShieldsTabState(wcId)
        .then((shields) => setSiteInfo((prev) => (prev ? { ...prev, shields } : prev)))
        .catch(() => {});
    }
  }

  async function toggleShieldsForActiveSite() {
    const shields = siteInfo?.shields;
    if (!shields?.site) return;
    await window.api?.setShieldsForSite(shields.site, !shields.shieldsUp);
    setSiteInfo(null);
    handleReloadActiveTab();
  }

  // ---- User settings (owned by main; see src/privacy.ts) ------------------------
  const [settings, setSettings] = useState<BrowserSettings | null>(null);

  useEffect(() => {
    const apply = (next: BrowserSettings) => {
      setSearchEngine(next.searchEngine);
      setSettings(next);
    };
    window.api?.getSettings().then(apply).catch(() => {});
    const cleanup = window.api?.onSettingsChanged(apply);
    return () => cleanup?.();
  }, []);

  async function clearActiveSiteData() {
    const activeTab = tabsRef.current.find((t) => t.isActive);
    if (!activeTab) return;
    if (!siteInfo?.confirmClear) {
      setSiteInfo((prev) => (prev ? { ...prev, confirmClear: true } : prev));
      return;
    }
    const host = hostnameOf(activeTab.url);
    if (!host) return;
    try {
      await window.api?.clearSiteData(siteOf(host));
    } finally {
      setSiteInfo(null);
      handleReloadActiveTab();
    }
  }

  function dismissTransientUi() {
    setContextMenu(null);
    setZoomBubble(null);
    setAppMenuOpen(false);
    setSiteInfo(null);
    setSuggestions([]);
  }

  useEffect(() => {
    const cleanup = window.api?.onWindowBlur(() => {
      setContextMenu(null);
      setAppMenuOpen(false);
      setSiteInfo(null);
    });
    return () => cleanup?.();
  }, []);

  // ---- Keyboard shortcuts (forwarded from the main process) ---------------------
  function handleBrowserCommand(name: string, arg?: number) {
    const live = tabsRef.current.filter((t) => !closingIdsRef.current.has(t.id));
    const activeTab = live.find((t) => t.isActive);

    switch (name) {
      case "new-tab":
        addTab(NEW_TAB_URL);
        break;
      case "reopen-closed-tab":
        reopenClosedTab();
        break;
      case "close-tab":
        if (activeTab) closeTab(activeTab.id);
        break;
      case "reload":
        handleReloadActiveTab();
        break;
      case "hard-reload":
        handleReloadActiveTab(true);
        break;
      case "zoom-in":
        changeActiveZoom(1);
        break;
      case "zoom-out":
        changeActiveZoom(-1);
        break;
      case "zoom-reset":
        changeActiveZoom(0);
        break;
      case "find":
        openFindBar();
        break;
      case "find-next":
      case "find-prev":
        if (showFindBar && findQuery) performFind(findQuery, name === "find-next", true);
        else openFindBar();
        break;
      case "focus-address":
        focusAddressBar(true);
        break;
      case "history":
        if (!IS_INCOGNITO) openSingletonTab(HISTORY_URL, isHistoryUrl);
        break;
      case "site-data":
        openSingletonTab(COOKIES_URL, isCookiesUrl);
        break;
      case "back":
        goBack();
        break;
      case "forward":
        goForward();
        break;
      case "next-tab":
      case "prev-tab": {
        if (!activeTab || live.length < 2) break;
        const step = name === "next-tab" ? 1 : -1;
        const index = live.indexOf(activeTab);
        activateTab(live[(index + step + live.length) % live.length].id);
        break;
      }
      case "select-tab": {
        if (!arg) break;
        const target = arg === 9 ? live[live.length - 1] : live[arg - 1];
        if (target) activateTab(target.id);
        break;
      }
      case "devtools":
        if (!activeTab) break;
        // Ctrl+Shift+C only ever opens (it's "inspect element" in Chrome).
        if (arg === 1) openDevToolsForTab(activeTab.id);
        else toggleDevToolsForTab(activeTab.id);
        break;
      case "escape":
        dismissTransientUi();
        if (activeTab?.isLoading && !isInternalUrl(activeTab.url)) handleStopActiveTab();
        break;
    }
  }

  // Registered once; always dispatch to the latest render's handler.
  const browserCommandRef = useRef(handleBrowserCommand);
  useLayoutEffect(() => {
    browserCommandRef.current = handleBrowserCommand;
  });
  useEffect(() => {
    const cleanup = window.api?.onBrowserCommand((name, arg) => browserCommandRef.current(name, arg));
    return () => cleanup?.();
  }, []);

  // ---- Tab drag-to-reorder -------------------------------------------------------
  const tabDragRef = useRef<{ id: string; startX: number; started: boolean; order: string[] } | null>(null);
  const [draggingTab, setDraggingTab] = useState<{ id: string; dx: number } | null>(null);

  function handleTabMouseDown(e: ReactMouseEvent, tab: Tab) {
    if (e.button === 1) {
      e.preventDefault(); // no autoscroll cursor; closing happens on auxclick
      return;
    }
    if (e.button !== 0 || closingIdsRef.current.has(tab.id)) return;
    // Chrome activates on press, not release.
    activateTab(tab.id);

    const slot = effectiveTabWidth + TAB_GAP;
    tabDragRef.current = {
      id: tab.id,
      startX: e.clientX,
      started: false,
      order: tabsRef.current.filter((t) => !closingIdsRef.current.has(t.id)).map((t) => t.id),
    };

    const onMove = (ev: MouseEvent) => {
      const drag = tabDragRef.current;
      if (!drag) return;
      let dx = ev.clientX - drag.startX;
      if (!drag.started) {
        if (Math.abs(dx) < 5) return;
        drag.started = true;
      }
      const from = drag.order.indexOf(drag.id);
      const steps = Math.trunc(dx / slot + (dx > 0 ? 0.5 : -0.5));
      const to = Math.max(0, Math.min(drag.order.length - 1, from + steps));
      if (to !== from) {
        const order = [...drag.order];
        order.splice(from, 1);
        order.splice(to, 0, drag.id);
        drag.order = order;
        drag.startX += (to - from) * slot;
        dx = ev.clientX - drag.startX;
        const position = new Map(order.map((id, i) => [id, i]));
        setTabs((currentTabs) =>
          [...currentTabs].sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity))
        );
      }
      // Don't let the dragged tab leave the strip.
      const index = drag.order.indexOf(drag.id);
      const minDx = -index * slot - 6;
      const maxDx = (drag.order.length - 1 - index) * slot + 6;
      setDraggingTab({ id: drag.id, dx: Math.max(minDx, Math.min(maxDx, dx)) });
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      tabDragRef.current = null;
      setDraggingTab(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ---- Misc. chrome polish -------------------------------------------------------
  // The taskbar / Alt+Tab title follows the active tab, like any browser.
  const activeTabForUi = tabs.find((t) => t.isActive);
  useEffect(() => {
    const appName = IS_INCOGNITO ? "Indus (Incognito)" : "Indus";
    document.title = activeTabForUi ? `${tabDisplayTitle(activeTabForUi)} - ${appName}` : appName;
  }, [activeTabForUi?.title, activeTabForUi?.url]);

  useEffect(() => {
    setHoverUrl("");
    setZoomBubble(null);
    setSiteInfo(null);
  }, [activeTabId]);

  const activeRuntime = activeTabForUi ? tabRuntime[activeTabForUi.id] : undefined;
  const zoomPercent = Math.round((activeRuntime?.zoom ?? 1) * (activeRuntime?.pinch ?? 1) * 100);
  const activeIsWeb = Boolean(activeTabForUi && !isInternalUrl(activeTabForUi.url));
  const activeIsSecure = Boolean(activeTabForUi?.url.startsWith("https://"));
  const canGoBack = Boolean(activeTabForUi && activeTabForUi.historyIndex > 0);
  const canGoForward = Boolean(activeTabForUi && activeTabForUi.historyIndex < activeTabForUi.history.length - 1);
  const showSuggestions = addressFocused && suggestions.length > 0;
  const activeDevtoolsOpen = Boolean(activeTabForUi && devtools[activeTabForUi.id]?.open);

  useEffect(() => {
    setShowFindBar(false);
  }, [activeTabId]);

  useEffect(() => {
    const webview = getActiveWebview();
    if (!webview) return;
    const handler = (e: any) => {
      setFindMatches({ activeMatch: e.result.activeMatchOrdinal, matches: e.result.matches });
    };
    webview.addEventListener('found-in-page', handler);
    return () => webview.removeEventListener('found-in-page', handler);
  }, [activeTabId]);

  useEffect(() => {
    const cleanup = window.api?.onDownloadStarted((_event: any, info: { id: string; filename: string }) => {
      setDownloads(prev => [...prev, { id: info.id, filename: info.filename, percent: 0, done: false }]);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onDownloadProgress((_event: any, info: { id: string; percent: number | null }) => {
      setDownloads(prev => prev.map(d => d.id === info.id ? { ...d, percent: info.percent } : d));
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onDownloadDone((_event: any, info: { id: string; success: boolean; path: string }) => {
      setDownloads(prev => prev.map(d => d.id === info.id ? { ...d, done: true, success: info.success, path: info.path } : d));
      window.setTimeout(() => {
        setDownloads(prev => prev.filter(d => d.id !== info.id));
      }, 6000);
    });
    return () => cleanup?.();
  }, []);

  return (
    <div className={`app-container dark${IS_INCOGNITO ? " incognito" : ""}`}>
      {/* Agent click cursor flash */}
      {agentCursor && (
        <img
          src={cursorIcon}
          className="agent-cursor-indicator"
          style={{ left: agentCursor.x, top: agentCursor.y }}
        />
      )}
      {/* Mouse Coordinate Display */}
      {showMouseCoords && (
        <div
          className="mouse-coords-overlay"
          onClick={() => setShowMouseCoords(false)}
          title="Click to close"
        >
          X: {mousePos.x} &nbsp; Y: {mousePos.y}
        </div>
      )}
      {/* Overlay to capture mouse events during resizing / tab dragging, preventing webview interference */}
      {(isResizingSidebar || isResizingDevtools || draggingTab) && (
        <div
          className="interaction-shield"
          style={{ cursor: draggingTab ? "default" : "col-resize" }}
        />
      )}

      {contextMenu && <ContextMenu key={`${contextMenu.x},${contextMenu.y}`} menu={contextMenu} onClose={() => setContextMenu(null)} />}

      {/* Tab Bar */}
      <div
        className={`tab-bar${draggingTab ? " dragging-tabs" : ""}`}
        onMouseLeave={() => setFrozenTabWidth(null)}
      >
        {tabs.map((tab) => {
          const closing = closingIds.has(tab.id);
          const runtime = tabRuntime[tab.id];
          const title = tabDisplayTitle(tab);
          const isDragging = draggingTab?.id === tab.id;
          const narrow = effectiveTabWidth < 64;
          return (
            <div
              key={tab.id}
              onMouseDown={(e) => handleTabMouseDown(e, tab)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(tab.id, { viaMouse: true });
                }
              }}
              onContextMenu={(e) => handleTabContextMenu(e, tab)}
              className={[
                "tab",
                tab.isActive && "active",
                closing && "closing",
                isDragging && "dragging",
                narrow && "narrow",
                enteringTabIds.has(tab.id) && "entering",
              ].filter(Boolean).join(" ")}
              style={{
                width: `${effectiveTabWidth}px`,
                transform: isDragging ? `translateX(${draggingTab.dx}px)` : undefined,
              }}
              title={isInternalUrl(tab.url) ? title : `${title}\n${formatDisplayUrl(tab.url)}`}
            >
              {tab.isLoading && !isInternalUrl(tab.url) ? (
                <span className="tab-spinner" aria-label="Loading" />
              ) : isInternalUrl(tab.url) ? (
                <img src={logo} alt="" className="tab-favicon" />
              ) : (
                <TabFavicon key={tab.faviconUrl ?? "none"} src={tab.faviconUrl} />
              )}
              <span className="tab-title">{title}</span>
              {(runtime?.audible || runtime?.muted) && !narrow && (
                <button
                  type="button"
                  className={`tab-audio${runtime?.muted ? " muted" : ""}`}
                  title={runtime?.muted ? "Unmute tab" : "Mute tab"}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleTabMuted(tab.id);
                  }}
                >
                  <span className="material-symbols-outlined">{runtime?.muted ? "volume_off" : "volume_up"}</span>
                </button>
              )}
              <button
                type="button"
                className="tab-close"
                title="Close tab (Ctrl+W)"
                aria-label="Close tab"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id, { viaMouse: true });
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <path d="M9,1L1,9M1,1l8,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
        <button
          onClick={() => addTab(NEW_TAB_URL)}
          className="new-tab-button"
          title="New tab (Ctrl+T)"
          aria-label="New tab"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>

        {/* Window Controls - Windows (right side) */}
        {platform === 'win32' && (
          <div className="window-controls window-controls-windows">
            <button className="win-control" onClick={handleMinimize} title="Minimize">
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4" width="8" height="1" fill="currentColor"/></svg>
            </button>
            <button className="win-control" onClick={handleMaximize} title={isMaximized ? "Restore" : "Maximize"}>
              {isMaximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="1.5" y="3.5" width="5" height="5" />
                  <path d="M3.5 3.5V1.5h5v5h-2" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1,1v8h8V1H1z M8,8H2V2h6V8z" fill="currentColor"/></svg>
              )}
            </button>
            <button className="win-control win-close" onClick={handleClose} title="Close">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M10,1L9,0L5,4L1,0L0,1l4,4L0,9l1,1l4-4l4,4l1-1L6,5L10,1z" fill="currentColor"/></svg>
            </button>
          </div>
        )}
      </div>

      {/* Toolbar & Address Bar */}
      <div className="toolbar">
        {/* Navigation Controls */}
        <div className="nav-controls">
          <button className="nav-button" onClick={goBack} disabled={!canGoBack} title="Back (Alt+Left)">
            <img src={backIcon} alt="Back" />
          </button>
          <button className="nav-button" onClick={goForward} disabled={!canGoForward} title="Forward (Alt+Right)">
            <img src={forwardIcon} alt="Forward" />
          </button>
          {activeTabForUi?.isLoading && activeIsWeb ? (
            <button className="nav-button" onClick={handleStopActiveTab} title="Stop loading (Esc)">
              <svg className="nav-svg" width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2.5 2.5l9 9M11.5 2.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          ) : (
            <button
              className="nav-button reload-button"
              onClick={(e) => handleReloadActiveTab(e.shiftKey || e.ctrlKey)}
              disabled={!activeIsWeb}
              title="Reload (Ctrl+R)"
            >
              <img src={refreshIcon} alt="Reload" />
            </button>
          )}
        </div>

        {/* Address Bar */}
        <div
          className={`address-bar${addressFocused ? " focused" : ""}${showSuggestions ? " with-suggestions" : ""}`}
          onMouseDown={(e) => {
            // Clicking the bar's padding should focus the input too.
            if (e.target === e.currentTarget) {
              e.preventDefault();
              focusAddressBar(true);
            }
          }}
        >
          <div className="site-info-anchor" ref={siteInfoRef}>
            {activeIsWeb && !addressFocused ? (
              <button
                type="button"
                className={`site-info-button${activeIsSecure ? "" : " insecure"}${siteInfo ? " open" : ""}`}
                onClick={() => (siteInfo ? setSiteInfo(null) : openSiteInfo())}
                title="View site information"
              >
                <span className="material-symbols-outlined">{activeIsSecure ? "tune" : "info"}</span>
                {!activeIsSecure && <span className="site-info-label">Not secure</span>}
              </button>
            ) : (
              <span className="address-search-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" fill="none" />
                  <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </span>
            )}

            {siteInfo && activeTabForUi && (
              <div className="popover site-info-popover" role="dialog">
                <div className="popover-title">{hostnameOf(activeTabForUi.url)}</div>
                <div className="site-info-row">
                  <span className={`material-symbols-outlined site-info-row-icon${activeIsSecure ? " secure" : " warn"}`}>
                    {activeIsSecure ? "lock" : "warning"}
                  </span>
                  <div className="site-info-row-text">
                    <div>{activeIsSecure ? "Connection is secure" : "Your connection to this site is not secure"}</div>
                    <div className="site-info-row-sub">
                      {activeIsSecure
                        ? "Information you send to this site is encrypted in transit."
                        : "Don’t enter passwords or payment details on this site."}
                    </div>
                  </div>
                </div>
                {siteInfo.shields?.site && (
                  <div className="site-info-row">
                    <span className={`material-symbols-outlined site-info-row-icon${siteInfo.shields.shieldsUp ? " secure" : ""}`}>
                      {siteInfo.shields.shieldsUp ? "shield" : "remove_moderator"}
                    </span>
                    <div className="site-info-row-text">
                      <div>Shields are {siteInfo.shields.shieldsUp ? "up" : "down"} for this site</div>
                      <div className="site-info-row-sub">
                        {siteInfo.shields.shieldsUp
                          ? `${siteInfo.shields.blocked} tracker${siteInfo.shields.blocked === 1 ? "" : "s"} & ads blocked on this page`
                          : "Trackers, ads and cookie protections are off here"}
                      </div>
                    </div>
                    <button type="button" className="popover-text-btn" onClick={toggleShieldsForActiveSite}>
                      {siteInfo.shields.shieldsUp ? "Turn off" : "Turn on"}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="site-info-row clickable"
                  onClick={() => {
                    const host = hostnameOf(activeTabForUi.url);
                    setSiteInfo(null);
                    openSingletonTab(`${COOKIES_URL}?site=${encodeURIComponent(siteOf(host))}`, isCookiesUrl);
                  }}
                >
                  <span className="material-symbols-outlined site-info-row-icon">cookie</span>
                  <div className="site-info-row-text">
                    <div>Cookies and site data</div>
                    <div className="site-info-row-sub">
                      {siteInfo.cookies === null ? "Counting…" : `${siteInfo.cookies} cookie${siteInfo.cookies === 1 ? "" : "s"} in use`}
                    </div>
                  </div>
                  <span className="material-symbols-outlined site-info-chevron">chevron_right</span>
                </button>
                {zoomPercent !== 100 && (
                  <div className="site-info-row">
                    <span className="material-symbols-outlined site-info-row-icon">zoom_in</span>
                    <div className="site-info-row-text">
                      <div>Zoom {zoomPercent}%</div>
                    </div>
                    <button type="button" className="popover-text-btn" onClick={() => changeActiveZoom(0)}>Reset</button>
                  </div>
                )}
                <div className="popover-footer">
                  <button
                    type="button"
                    className={`popover-danger-btn${siteInfo.confirmClear ? " confirm" : ""}`}
                    onClick={clearActiveSiteData}
                  >
                    {siteInfo.confirmClear ? "Click again to delete and reload" : "Delete data for this site"}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="address-input-wrap">
            {ghostSuffix && addressFocused && (
              <div className="address-ghost" aria-hidden="true">
                <span className="address-ghost-typed">{AddressBarValue}</span>
                <span className="address-ghost-suffix">{ghostSuffix}</span>
              </div>
            )}
            <input
              ref={addressInputRef}
              type="text"
              value={addressFocused ? AddressBarValue : formatDisplayUrl(AddressBarValue)}
              placeholder={`Search ${searchEngineName()} or type a URL`}
              spellCheck={false}
              autoComplete="off"
              onChange={handleAddressChange}
              className="address-input"
              onMouseDown={(e) => {
                // First click selects the whole URL, like Chrome; later clicks place the caret.
                if (document.activeElement !== e.currentTarget) {
                  e.preventDefault();
                  focusAddressBar(true);
                }
              }}
              onFocus={() => {
                addressBarFocusedRef.current = true;
                setAddressFocused(true);
                typedAddressRef.current = AddressBarValue;
              }}
              onBlur={() => {
                addressBarFocusedRef.current = false;
                setAddressFocused(false);
                setSuggestions([]);
                setSelectedSuggestion(-1);
                setGhostSuffix("");
                // Leaving the omnibox throws away an unsubmitted edit instead of navigating to it.
                if (skipRevertOnBlurRef.current) {
                  skipRevertOnBlurRef.current = false;
                  return;
                }
                setAddressBarValue(activeTabAddress());
              }}
              onKeyDown={handleAddressKeyDown}
            />
          </div>

          {/* Chip + bubble share one dismiss boundary so the chip can toggle the bubble. */}
          <div className="zoom-anchor" ref={zoomBubbleRef}>
          {activeIsWeb && zoomPercent !== 100 && !addressFocused && (
            <button
              type="button"
              className="address-chip-button"
              title={`Zoom: ${zoomPercent}%`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => (zoomBubble?.pinned ? setZoomBubble(null) : showZoomBubble(true))}
            >
              <span className="material-symbols-outlined">{zoomPercent > 100 ? "zoom_in" : "zoom_out"}</span>
            </button>
          )}

          {zoomBubble && activeIsWeb && (
            <div
              className="popover zoom-bubble"
              key={zoomBubble.pinned ? "pinned" : "auto"}
              onMouseEnter={() => (zoomBubbleHoverRef.current = true)}
              onMouseLeave={() => {
                zoomBubbleHoverRef.current = false;
                setZoomBubble((prev) => (prev ? { ...prev, seq: prev.seq + 1 } : prev));
              }}
            >
              <span className="zoom-bubble-value" key={zoomPercent}>{zoomPercent}%</span>
              <button type="button" className="zoom-bubble-btn" onClick={() => changeActiveZoom(-1)} title="Zoom out (Ctrl+−)" disabled={zoomPercent <= 25}>
                <span className="material-symbols-outlined">remove</span>
              </button>
              <button type="button" className="zoom-bubble-btn" onClick={() => changeActiveZoom(1)} title="Zoom in (Ctrl+=)" disabled={zoomPercent >= 500}>
                <span className="material-symbols-outlined">add</span>
              </button>
              <button type="button" className="zoom-bubble-reset" onClick={() => changeActiveZoom(0)} disabled={zoomPercent === 100}>
                Reset
              </button>
            </div>
          )}
          </div>

          {showSuggestions && (
            <div className="omnibox-suggestions" role="listbox" onMouseDown={(e) => e.preventDefault()}>
              {suggestions.map((s, i) => (
                <div
                  key={`${s.kind}-${s.url}-${i}`}
                  role="option"
                  aria-selected={i === selectedSuggestion}
                  className={`omnibox-suggestion${i === selectedSuggestion ? " selected" : ""}`}
                  onMouseEnter={() => setSelectedSuggestion(i)}
                  onClick={(e) => commitAddress(s, s.url, e.altKey)}
                >
                  <span className="material-symbols-outlined omnibox-suggestion-icon">
                    {s.kind === "search" ? "search" : s.kind === "tab" ? "tab" : s.kind === "history" ? "history" : "public"}
                  </span>
                  <span className="omnibox-suggestion-label">{s.label}</span>
                  {s.detail && <span className="omnibox-suggestion-detail">{s.kind === "search" || s.kind === "tab" ? `— ${s.detail}` : s.detail}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right Side Icons */}
        <div className="toolbar-right">
          {IS_INCOGNITO ? (
            <div className="incognito-badge" title="You’re browsing privately. Pages you view here won’t be saved to history, and cookies and site data are deleted when you close all incognito windows.">
              <span className="material-symbols-outlined">domino_mask</span>
              Incognito
            </div>
          ) : (
            <button
              className={`icon-button agent-button ${showAssistant ? "active" : ""}`}
              title="Agent"
              onClick={() => setShowAssistant(!showAssistant)}
            >
              <img src={logo} alt="" className="assistant-icon" />Agent
            </button>
          )}

          <div className="app-menu-anchor" ref={appMenuRef}>
            <button
              type="button"
              className={`nav-button app-menu-button${appMenuOpen ? " open" : ""}`}
              title="Customize and control Indus"
              aria-label="Menu"
              onClick={() => setAppMenuOpen((v) => !v)}
            >
              <span className="material-symbols-outlined">more_vert</span>
            </button>
            {appMenuOpen && (
              <div className="popover app-menu" role="menu">
                {(
                  [
                    { label: "New tab", icon: "add", shortcut: "Ctrl+T", onSelect: () => addTab(NEW_TAB_URL) },
                    { label: "New Incognito window", icon: "domino_mask", shortcut: "Ctrl+Shift+N", onSelect: () => window.api?.openIncognitoWindow() },
                    { label: "Reopen closed tab", icon: "undo", shortcut: "Ctrl+Shift+T", disabled: closedTabsRef.current.length === 0, onSelect: reopenClosedTab },
                  ] as const
                ).map((item) => (
                  <button key={item.label} type="button" className="app-menu-item" disabled={"disabled" in item && item.disabled} onClick={() => { setAppMenuOpen(false); item.onSelect(); }}>
                    <span className="material-symbols-outlined">{item.icon}</span>
                    <span className="app-menu-label">{item.label}</span>
                    <span className="app-menu-shortcut">{item.shortcut}</span>
                  </button>
                ))}
                <div className="app-menu-separator" />
                <div className="app-menu-zoom">
                  <span className="material-symbols-outlined">search</span>
                  <span className="app-menu-label">Zoom</span>
                  <div className="app-menu-zoom-controls">
                    <button type="button" onClick={() => changeActiveZoom(-1)} disabled={!activeIsWeb || zoomPercent <= 25} title="Zoom out (Ctrl+−)">
                      <span className="material-symbols-outlined">remove</span>
                    </button>
                    <button type="button" className="app-menu-zoom-value" onClick={() => changeActiveZoom(0)} disabled={!activeIsWeb} title="Reset (Ctrl+0)">
                      {activeIsWeb ? `${zoomPercent}%` : "—"}
                    </button>
                    <button type="button" onClick={() => changeActiveZoom(1)} disabled={!activeIsWeb || zoomPercent >= 500} title="Zoom in (Ctrl+=)">
                      <span className="material-symbols-outlined">add</span>
                    </button>
                  </div>
                </div>
                <div className="app-menu-separator" />
                {(
                  [
                    ...(IS_INCOGNITO ? [] : [{ label: "History", icon: "history", shortcut: "Ctrl+H", onSelect: () => openSingletonTab(HISTORY_URL, isHistoryUrl) }]),
                    { label: "Cookies and site data", icon: "cookie", shortcut: "Ctrl+Shift+Del", onSelect: () => openSingletonTab(COOKIES_URL, isCookiesUrl) },
                    { label: "Settings & Shields", icon: "settings", shortcut: "", onSelect: () => openSingletonTab(SETTINGS_URL, isSettingsUrl) },
                    { label: "Find…", icon: "find_in_page", shortcut: "Ctrl+F", disabled: !activeIsWeb, onSelect: openFindBar },
                    { label: activeDevtoolsOpen ? "Close developer tools" : "Developer tools", icon: "code", shortcut: "F12", disabled: !activeIsWeb, onSelect: () => activeTabForUi && toggleDevToolsForTab(activeTabForUi.id) },
                  ] as const
                ).map((item) => (
                  <button key={item.label} type="button" className="app-menu-item" disabled={"disabled" in item && item.disabled} onClick={() => { setAppMenuOpen(false); item.onSelect(); }}>
                    <span className="material-symbols-outlined">{item.icon}</span>
                    <span className="app-menu-label">{item.label}</span>
                    <span className="app-menu-shortcut">{item.shortcut}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Webview Container */}
      <div className="webview-container" ref={webviewContainerRef}>
        <div className="page-area">
        {/* Rendered in a fixed order (by id) independent of strip order: moving a
            <webview> in the DOM reloads it, so dragging tabs must never reorder these. */}
        {[...tabs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((tab) => {
          if (isNewTabUrl(tab.url)) {
            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                className={`new-tab-shell${newTabLeaving && tab.isActive ? " leaving" : ""}`}
                style={{ display: tab.isActive ? "flex" : "none" }}
              >
                <NewTabPage
                  displayName="npsboy"
                  incognito={IS_INCOGNITO}
                  onSearch={handleNewTabSearch}
                  routingError={newTabRoutingError}
                  onOpenChat={IS_INCOGNITO ? undefined : () => updateTabUrl(tab.id, "indus://chat")}
                />
              </div>
            );
          } else if (isChatUrl(tab.url)) {
            return (
              <div
                key={tab.id}
                className="chat-page-shell"
                style={{ display: tab.isActive ? "flex" : "none", flex: 1, width: "100%", height: "100%" }}
              >
                <ChatPage
                  tabId={tab.id}
                  initialUrl={tab.url}
                  onUrlChange={(newUrl) => updateTabUrl(tab.id, newUrl)}
                  onTitleChange={(title) => setTabTitle(tab.id, title)}
                  onExitToNewTab={() => updateTabUrl(tab.id, NEW_TAB_URL)}
                  onStartAgentTask={(text, taskHistory) => startAgentRun(text, taskHistory)}
                />
              </div>
            );
          } else if (isHistoryUrl(tab.url)) {
            return (
              <div
                key={tab.id}
                className="history-page-shell"
                style={{ display: tab.isActive ? "flex" : "none", flex: 1, width: "100%", height: "100%" }}
              >
                <HistoryPage
                  entries={history}
                  onOpenUrl={(url) => addTab(url, { openerId: tab.id })}
                  onClear={() => setHistory([])}
                  onClose={() => closeTab(tab.id)}
                />
              </div>
            );
          } else if (isCookiesUrl(tab.url)) {
            let initialSite: string | undefined;
            try {
              initialSite = new URL(tab.url).searchParams.get("site") ?? undefined;
            } catch {
              initialSite = undefined;
            }
            return (
              <div
                key={tab.id}
                className="cookies-page-shell"
                style={{ display: tab.isActive ? "flex" : "none", flex: 1, width: "100%", height: "100%" }}
              >
                <CookiesPage key={tab.url} initialSite={initialSite} onClose={() => closeTab(tab.id)} />
              </div>
            );
          } else if (isSettingsUrl(tab.url)) {
            return (
              <div
                key={tab.id}
                className="cookies-page-shell"
                style={{ display: tab.isActive ? "flex" : "none", flex: 1, width: "100%", height: "100%" }}
              >
                <SettingsPage settings={settings} onClose={() => closeTab(tab.id)} />
              </div>
            );
          } else {
            return (
              <webview
                ref={(el) => {
                  if (el) {
                    webviewRefs.current.set(tab.id, el);
                  } else {
                    webviewRefs.current.delete(tab.id);
                  }
                }}
                key={tab.id}
                src={webviewSrcFor(tab)}
                partition={WINDOW_CONFIG.partition}
                // @ts-ignore
                allowpopups="true"
                style={
                  !tab.isActive && agentWorkingTabIds.has(tab.id)
                    // An agent is working in this tab while you look at another. display:none would
                    // shrink its page to 0×0, so keep it laid out at full size behind everything.
                    ? { position: "absolute", inset: 0, width: "100%", height: "100%", display: "flex", zIndex: -1, pointerEvents: "none" }
                    : { flex: 1, height: "100%", display: tab.isActive ? "flex" : "none" }
                }
              />
            );
          }
        })}

        {activeTabForUi && activeIsWeb && activeRuntime?.error && (
          <div className="page-error">
            <span className="material-symbols-outlined page-error-icon">
              {activeRuntime.error.kind === "crash" ? "sentiment_dissatisfied" : activeRuntime.error.code === -106 ? "wifi_off" : "cloud_off"}
            </span>
            <h2>{activeRuntime.error.kind === "crash" ? "Aw, snap!" : "This site can’t be reached"}</h2>
            <p>
              {activeRuntime.error.kind === "crash"
                ? "Something went wrong while displaying this webpage."
                : friendlyLoadError(activeRuntime.error.code, hostnameOf(activeRuntime.error.url))}
            </p>
            {activeRuntime.error.kind === "load" && <code>{activeRuntime.error.description}</code>}
            <button type="button" className="page-error-button" onClick={() => handleReloadActiveTab()}>
              Reload
            </button>
          </div>
        )}

        {showFindBar && (
          <div className="find-bar">
            <input
              ref={findInputRef}
              className="find-bar-input"
              value={findQuery}
              onChange={(e) => {
                setFindQuery(e.target.value);
                performFind(e.target.value, true, false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  performFind(findQuery, !e.shiftKey, true);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeFindBar();
                  if (activeTabForUi) focusTabContent(activeTabForUi.id);
                }
              }}
              placeholder="Find in page"
            />
            <span className={`find-bar-count${findMatches && findQuery && findMatches.matches === 0 ? " no-match" : ""}`}>
              {findMatches && findQuery ? `${findMatches.matches > 0 ? findMatches.activeMatch : 0}/${findMatches.matches}` : ""}
            </span>
            <span className="find-bar-divider" />
            <button type="button" className="find-bar-nav" onClick={() => performFind(findQuery, false, true)} aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!findMatches?.matches}>
              <span className="material-symbols-outlined">keyboard_arrow_up</span>
            </button>
            <button type="button" className="find-bar-nav" onClick={() => performFind(findQuery, true, true)} aria-label="Next match" title="Next (Enter)" disabled={!findMatches?.matches}>
              <span className="material-symbols-outlined">keyboard_arrow_down</span>
            </button>
            <button type="button" className="find-bar-close" onClick={closeFindBar} aria-label="Close find bar" title="Close (Esc)">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        )}

        {/* Chrome's link-hover status bubble */}
        <div className={`status-bubble${hoverUrl && activeIsWeb ? " visible" : ""}`} aria-hidden="true">
          {hoverUrl}
        </div>

        {downloads.length > 0 && (
          <div className="download-toast-list">
            {downloads.map((d) => (
              <div
                key={d.id}
                className={`download-toast${d.done ? (d.success ? ' download-toast-done' : ' download-toast-failed') : ''}`}
                onClick={() => d.done && d.success && d.path && window.api?.showItemInFolder(d.path)}
                title={d.done && d.success ? "Show in folder" : undefined}
              >
                <span className="material-symbols-outlined download-toast-icon">
                  {!d.done ? "downloading" : d.success ? "check_circle" : "error"}
                </span>
                <div className="download-toast-body">
                  <span className="download-toast-name">{d.filename}</span>
                  <span className="download-toast-status">
                    {!d.done ? (d.percent != null ? `${d.percent}%` : "Downloading…") : d.success ? "Done — click to show in folder" : "Failed"}
                  </span>
                  {!d.done && (
                    <span className="download-toast-progress">
                      <span
                        className={`download-toast-progress-fill${d.percent == null ? " indeterminate" : ""}`}
                        style={d.percent != null ? { width: `${d.percent}%` } : undefined}
                      />
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="download-toast-dismiss"
                  aria-label="Dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDownloads((prev) => prev.filter((x) => x.id !== d.id));
                  }}
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            ))}
          </div>
        )}
        </div>

        {tabs.map((tab) =>
          devtools[tab.id] && !isInternalUrl(tab.url) ? (
            <DevToolsPanel
              key={`devtools-${tab.id}`}
              request={devtools[tab.id]}
              visible={tab.isActive && devtools[tab.id].open}
              width={devtoolsWidth}
              getTargetId={() => getWebContentsIdForTab(tab.id)}
              onClose={() => closeDevToolsForTab(tab.id)}
              onResizeStart={(clientX) => {
                devtoolsResizeRef.current = { startX: clientX, startWidth: devtoolsWidth };
                setIsResizingDevtools(true);
              }}
            />
          ) : null
        )}

        {showAssistant && !IS_INCOGNITO && (
          <div 
            className="assistant-sidebar" 
            style={{ width: `${sidebarWidth}px` }}
          >
            <div
              className="sidebar-resizer"
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingSidebar(true);
              }}
            />
            <div className="assistant-sidebar-top">
              <span className="assistant-sidebar-title">{ASSISTANT_MODE_LABELS[assistantMode]}</span>
              <div className="assistant-sidebar-top-actions">
                <button
                  type="button"
                  className="assistant-icon-btn"
                  title="New session"
                  aria-label="New session"
                  onClick={startNewSidebarSession}
                >
                  <span className="material-symbols-outlined">edit_square</span>
                </button>
                <button
                  type="button"
                  className={`assistant-icon-btn${showSessionHistory ? ' active' : ''}`}
                  title="Session history"
                  aria-label="Session history"
                  onClick={() => setShowSessionHistory(v => !v)}
                >
                  <span className="material-symbols-outlined">history</span>
                </button>
              </div>
            </div>
            {showAgentPanels && receivedTips.length > 0 && (
              <div className="agent-notepad">
                <button
                  type="button"
                  className="agent-notepad-toggle"
                  onClick={() => setIsTipsOpen(open => !open)}
                  aria-expanded={isTipsOpen}
                >
                  <span className="material-symbols-outlined agent-notepad-icon">lightbulb</span>
                  <span className="agent-notepad-title">Received tips</span>
                  <span className="agent-notepad-count">{receivedTips.length}</span>
                  <span className={`agent-group-chevron${isTipsOpen ? ' agent-group-chevron-expanded' : ''}`}>
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                      <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
                {isTipsOpen && (
                  <div className="agent-notepad-list">
                    {receivedTips.map(tip => {
                      const isOpen = expandedTips.has(tip.id);
                      return (
                        <button
                          key={tip.id}
                          type="button"
                          className={`agent-note${isOpen ? ' agent-note-open' : ''}`}
                          onClick={() => setExpandedTips(prev => {
                            const next = new Set(prev);
                            if (!next.delete(tip.id)) next.add(tip.id);
                            return next;
                          })}
                          aria-expanded={isOpen}
                        >
                          <span className="agent-note-text">
                            <span className="agent-tip-source">{tip.auto ? 'Auto-sent' : 'Requested'}</span>
                            {isOpen ? tip.text : tip.description}
                          </span>
                          <span className={`agent-group-chevron${isOpen ? ' agent-group-chevron-expanded' : ''}`}>
                            <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {showAgentPanels && agentNotes.trim() && (() => {
              const notes = agentNotes
                .split('\n')
                .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
                .filter(Boolean);
              return (
                <div className={`agent-notepad${notepadFlash ? ' agent-notepad-flash' : ''}`}>
                  <button
                    type="button"
                    className="agent-notepad-toggle"
                    onClick={() => setIsNotepadOpen(open => !open)}
                    aria-expanded={isNotepadOpen}
                  >
                    <span className="material-symbols-outlined agent-notepad-icon">sticky_note_2</span>
                    <span className="agent-notepad-title">Notepad</span>
                    <span className="agent-notepad-count">{notes.length}</span>
                    <span className="agent-notepad-preview">
                      {!isNotepadOpen ? notes[notes.length - 1] : ''}
                    </span>
                    <span className={`agent-group-chevron${isNotepadOpen ? ' agent-group-chevron-expanded' : ''}`}>
                      <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </button>
                  {isNotepadOpen && (
                    <div className="agent-notepad-list">
                      {notes.map((note, i) => {
                        const isOpen = expandedNotes.has(i);
                        return (
                          <button
                            key={i}
                            type="button"
                            className={`agent-note${isOpen ? ' agent-note-open' : ''}`}
                            onClick={() => setExpandedNotes(prev => {
                              const next = new Set(prev);
                              if (!next.delete(i)) next.add(i);
                              return next;
                            })}
                            aria-expanded={isOpen}
                          >
                            <span className="agent-note-text">{note}</span>
                            <span className={`agent-group-chevron${isOpen ? ' agent-group-chevron-expanded' : ''}`}>
                              <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                                <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
            {showSessionHistory ? (
              <div className="assistant-session-history">
                {sidebarSessions.filter(s => s.mode === assistantMode).length === 0 ? (
                  <div className="assistant-session-empty">No {ASSISTANT_MODE_LABELS[assistantMode].toLowerCase()} sessions yet.</div>
                ) : (
                  sidebarSessions
                    .filter(s => s.mode === assistantMode)
                    .map(session => (
                      <div
                        key={session.id}
                        className={`assistant-session-item${session.id === currentSessionId ? ' active' : ''}`}
                        onClick={() => openSidebarSession(session)}
                      >
                        {runningAgents[session.id] && (
                          <span
                            className={`assistant-session-running${runningAgents[session.id].paused ? ' paused' : ''}`}
                            title={runningAgents[session.id].paused ? 'Agent paused' : 'Agent running'}
                          />
                        )}
                        <span className="assistant-session-title">{session.title}</span>
                        <span className="assistant-session-date">{formatSessionDate(session.updatedAt)}</span>
                        <button
                          type="button"
                          className="assistant-session-delete"
                          onClick={(e) => { e.stopPropagation(); deleteSidebarSession(session.id); }}
                          aria-label="Delete session"
                        >
                          ×
                        </button>
                      </div>
                    ))
                )}
              </div>
            ) : (
            <div className="assistant-messages">
              {chatMessages.length === 0 ? (
                <div className="assistant-empty-state">
                  <img src={logo} alt="Agent" className="agent-logo-large" />
                  <h2>{ASSISTANT_MODE_LABELS[assistantMode]}</h2>
                </div>
              ) : (
                (() => {
                  type AgentBlock = { kind: 'agent-group'; startIndex: number; items: ChatMessage[] };
                  type SingleBlock = { kind: 'single'; index: number; msg: ChatMessage };
                  const blocks: (AgentBlock | SingleBlock)[] = [];

                  chatMessages.forEach((msg, i) => {
                    if (msg.role === 'agent') {
                      const last = blocks[blocks.length - 1];
                      if (last && last.kind === 'agent-group') {
                        last.items.push(msg);
                      } else {
                        blocks.push({ kind: 'agent-group', startIndex: i, items: [msg] });
                      }
                    } else {
                      blocks.push({ kind: 'single', index: i, msg });
                    }
                  });

                  return blocks.map((block, blockIndex) => {
                    if (block.kind === 'single') {
                      const { index: i, msg } = block;
                      if (msg.role === 'user') {
                        return (
                          <div key={i} className="chat-message chat-message-user">
                            <span className="chat-bubble">{msg.text}</span>
                          </div>
                        );
                      }
                      if (msg.role === 'reply') {
                        return (
                          <div key={i} className="chat-message chat-message-reply">
                            <div className="chat-reply-header">
                              <img src={logo} alt="Indus" className="agent-action-logo" />
                            </div>
                            <div className="chat-bubble chat-bubble-reply markdown-content">
                              <ReactMarkdown>{msg.text}</ReactMarkdown>
                            </div>
                          </div>
                        );
                      }
                      if (msg.role === 'mode') {
                        const toAgent = msg.text === 'agent';
                        return (
                          <div key={i} className="chat-mode-switch" role="separator">
                            <span className="material-symbols-outlined">{toAgent ? 'smart_toy' : 'chat_bubble'}</span>
                            Switched to {toAgent ? 'Agent' : 'Chat'}
                          </div>
                        );
                      }
                      if (msg.role === 'supervisor') {
                        return (
                          <div key={i} className="chat-message chat-message-supervisor">
                            <div className={`chat-notice chat-notice-supervisor${toggledNotices.has(i) ? '' : ' chat-notice-collapsed'}`}>
                              <button
                                type="button"
                                className="chat-notice-label"
                                onClick={() => toggleNotice(i)}
                                aria-expanded={toggledNotices.has(i)}
                              >
                                <span className="material-symbols-outlined">visibility</span>
                                Supervisor interruption
                                <span className={`agent-group-chevron${toggledNotices.has(i) ? ' agent-group-chevron-expanded' : ''}`}>
                                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                                    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </span>
                              </button>
                              {toggledNotices.has(i) && <span className="chat-notice-text">{msg.text}</span>}
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={i} className="chat-message chat-message-warning">
                          <div className={`chat-notice chat-notice-warning${!toggledNotices.has(i) ? '' : ' chat-notice-collapsed'}`}>
                              <button
                                type="button"
                                className="chat-notice-label"
                                onClick={() => toggleNotice(i)}
                                aria-expanded={!toggledNotices.has(i)}
                              >
                                <span className="material-symbols-outlined">error</span>
                                Warning
                                <span className={`agent-group-chevron${!toggledNotices.has(i) ? ' agent-group-chevron-expanded' : ''}`}>
                                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                                    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </span>
                              </button>
                              {!toggledNotices.has(i) && <span className="chat-notice-text">{msg.text}</span>}
                            </div>
                        </div>
                      );
                    }

                    const isExpanded = expandedAgentGroups.has(block.startIndex);
                    const isActiveGroup = isAgentRunning && blockIndex === blocks.length - 1;
                    const currentStep = block.items[block.items.length - 1];

                    return (
                      <div key={`group-${block.startIndex}`} className="agent-action-item">
                        <div className="agent-action-header">
                          <img src={logo} alt="Indus" className="agent-action-logo" />
                        </div>
                        <button
                          type="button"
                          className="agent-group-toggle"
                          onClick={() => toggleAgentGroup(block.startIndex)}
                          aria-expanded={isExpanded}
                        >
                          <span className={`agent-action-dot${isActiveGroup ? ' agent-action-dot-active' : ''}`} />
                          <span className="agent-group-summary markdown-content">
                            <ReactMarkdown>{currentStep.text}</ReactMarkdown>
                          </span>
                          <span className={`agent-group-chevron${isExpanded ? ' agent-group-chevron-expanded' : ''}`}>
                            <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="agent-action-steps">
                            {block.items.map((item, j) => (
                              <div key={j} className="agent-action-step">
                                <div className="agent-action-line-wrap">
                                  <div className="agent-action-dot" />
                                  {j < block.items.length - 1 && <div className="agent-action-connector" />}
                                </div>
                                <div className="agent-action-text markdown-content">
                                  <ReactMarkdown>{item.text}</ReactMarkdown>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()
              )}
              {assistantMode !== 'agent' && chatStreamingReply !== null && (
                <div className="chat-message chat-message-reply">
                  <div className="chat-reply-header">
                    <img src={logo} alt="Indus" className="agent-action-logo" />
                  </div>
                  <div className="chat-bubble chat-bubble-reply markdown-content">
                    <ReactMarkdown>{chatStreamingReply}</ReactMarkdown>
                  </div>
                </div>
              )}
              {assistantMode !== 'agent' && isChatLoading && chatStreamingReply === null && (
                <div className="chat-message chat-message-reply">
                  <span className="chat-bubble chat-bubble-reply chat-bubble-loading">{chatLoadingText}</span>
                </div>
              )}
              {taskSuggestion.pendingTaskSuggestion && (
                <div className="task-suggestion-banner">
                  <span>This looks like a task.</span>
                  <button
                    type="button"
                    className="task-suggestion-button"
                    onClick={() => startAgentRun(taskSuggestion.pendingTaskSuggestion!)}
                  >
                    Switch to Agent
                  </button>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            )}

            <div className="assistant-input-container">
              {isAgentRunning && (
                <div className="agent-control-row">
                  <button
                    className="agent-control-button"
                    onClick={isAgentPaused ? handleAgentResume : handleAgentPause}
                    title={isAgentPaused ? "Resume" : "Pause"}
                  >
                    <img src={isAgentPaused ? playIcon : pauseIcon} alt={isAgentPaused ? "Resume" : "Pause"} />
                  </button>
                  {currentStepDelay && (
                    <div
                      className={`agent-step-delay-chip${stepWaitLeft > 0 ? ' agent-step-delay-chip-waiting' : ''}`}
                      title={currentStepDelay.isDefault
                        ? 'Default wait between agent steps'
                        : currentStepDelay.reason ? `Set by the planner: ${currentStepDelay.reason}` : 'Set by the planner'}
                    >
                      <span className="material-symbols-outlined">timer</span>
                      {stepWaitLeft > 0
                        ? `Next step in ${stepWaitLeft}s`
                        : `${+(currentStepDelay.ms / 1000).toFixed(1)}s between steps${currentStepDelay.isDefault ? ' (default)' : ''}`}
                    </div>
                  )}
                </div>
              )}
              {assistantMode !== 'agent' && imageAttachment.pendingImage && (
                <div className="pending-attachment-chip">
                  <img
                    src={imageAttachment.pendingImage.dataUrl}
                    alt={imageAttachment.pendingImage.name}
                    className="pending-attachment-thumb"
                  />
                  <span className="pending-attachment-name">{imageAttachment.pendingImage.name}</span>
                  <button
                    type="button"
                    className="pending-attachment-remove"
                    onClick={imageAttachment.clear}
                    aria-label="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              )}
              {assistantMode !== 'agent' && imageAttachment.error && (
                <div className="pending-attachment-error">{imageAttachment.error}</div>
              )}
              <div className="assistant-input-row">
                <textarea
                  ref={textareaRef}
                  placeholder={assistantMode === 'agent' ? "Assign any task..." : assistantMode === 'auto' ? "Ask anything or assign a task..." : "Ask anything..."} 
                  className="assistant-text-input"
                  autoFocus
                  rows={1}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onInput={handleInputResize}
                  onPaste={assistantMode !== 'agent' ? imageAttachment.handlePaste : undefined}
                  onDrop={assistantMode !== 'agent' ? imageAttachment.handleDrop : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleAgentSend();
                    }
                  }}
                  style={{
                    minHeight: '40px',
                    padding: '10px 14px',
                    fontSize: '14px',
                    resize: 'none',
                    overflowY: 'hidden'
                  }}
                />
                {isAgentRunning ? (
                  <button className="agent-stop-button" onClick={handleAgentStop} title="Stop">
                    <img src={stopIcon} alt="Stop" />
                  </button>
                ) : (
                  <button
                    className="assistant-send-button"
                    onClick={handleAgentSend}
                    disabled={assistantMode !== 'agent' && isChatLoading}
                  >
                    ➤
                  </button>
                )}
              </div>
              <div className="assistant-input-footer">
                {assistantMode !== 'agent' && (
                  <>
                    <input {...imageAttachment.fileInputProps} />
                    <button
                      type="button"
                      className="assistant-attach-button"
                      title="Attach image"
                      onClick={imageAttachment.pick}
                    >
                      <span>📎</span>
                    </button>
                  </>
                )}

                <div style={{ position: 'relative' }}>
                  <button 
                    className="assistant-mode-button" 
                    onClick={() => setShowAssistantMenu(!showAssistantMenu)}
                  >
                    {ASSISTANT_MODE_LABELS[assistantMode]}
                    <span className="dropdown-icon" aria-hidden="true">
                      <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </button>
                  
                  {showAssistantMenu && (
                    <div className="assistant-mode-menu">
                      {(['auto', 'agent', 'chat'] as const).map(mode => (
                        <div
                          key={mode}
                          className="assistant-mode-item"
                          title={mode === 'auto' ? 'Decides for each message whether to chat or run the agent' : undefined}
                          onClick={() => { setAssistantMode(mode); setShowAssistantMenu(false); }}
                        >
                          {ASSISTANT_MODE_LABELS[mode]}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
