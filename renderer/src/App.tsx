import { useState, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import "./App.css";
import logo from "./assets/logos/Logo-Orange.png";
import favicon from "./assets/logos/Favicon.png";
import backIcon from "./assets/Icons/Back-Grey.png";
import forwardIcon from "./assets/Icons/Forward-Grey.png";
import refreshIcon from "./assets/Icons/Refresh-Grey.png";
import loadingAnimation from "./assets/Icons/loading-animation.gif";
import cursorIcon from "./assets/Icons/cursor-white.png";
import stopIcon from "./assets/Icons/Stop-white.png";
import pauseIcon from "./assets/Icons/Pause-White.png";
import playIcon from "./assets/Icons/Play-White.png";
import NewTabPage from "./pages/NewTabPage";
import ChatPage from "./pages/ChatPage";
import { useLoadingText } from "./hooks/useLoadingText";
import { useImageAttachment } from "./hooks/useImageAttachment";
import { useTaskSuggestion } from "./hooks/useTaskSuggestion";
import HistoryPage, { type HistoryEntry } from "./pages/HistoryPage";

const NEW_TAB_URL = "indus://newtab";
const TAB_STATE_STORAGE_KEY = "indus-browser.tabs.v1";
const HISTORY_STORAGE_KEY = "indus-browser.history.v1";
const SIDEBAR_SESSIONS_STORAGE_KEY = "indus-browser.sidebar-sessions.v1";
const isNewTabUrl = (url: string) => url === NEW_TAB_URL;
const isChatUrl = (url: string) => url.startsWith("indus://chat");
const isHistoryUrl = (url: string) => url === "indus://history";
type DispatcherRoute = {
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
  return isNewTabUrl(url) || isChatUrl(url) || isHistoryUrl(url);
}

function loadHistory(): HistoryEntry[] {
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

function cloneTabs(tabs: Tab[]): Tab[] {
  return tabs.map((tab) => ({
    ...tab,
    history: [...tab.history],
  }));
}

function normalizeTabs(tabs: unknown): Tab[] {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return cloneTabs(DEFAULT_TABS);
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
    return cloneTabs(DEFAULT_TABS);
  }

  if (!normalizedTabs.some((tab) => tab.isActive)) {
    normalizedTabs[normalizedTabs.length - 1].isActive = true;
  }

  return normalizedTabs;
}

function loadPersistedTabs(): Tab[] {
  try {
    const raw = window.localStorage.getItem(TAB_STATE_STORAGE_KEY);
    if (!raw) {
      return cloneTabs(DEFAULT_TABS);
    }

    return normalizeTabs(JSON.parse(raw));
  } catch {
    return cloneTabs(DEFAULT_TABS);
  }
}

function googleSearchUrl(query: string) {
  return "https://www.google.com/search?q=" + encodeURIComponent(query);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Dispatcher request timed out"));
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

function parseDispatcherJson(text: string): DispatcherRoute | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(trimmed);
    return parseDispatcherRoute(parsed);
  } catch {
    const routingMatch = trimmed.match(/routing\s*[:=]\s*["']?(web-search|ai-chat)["']?/i);
    if (!routingMatch) return null;

    const chatTitleMatch = trimmed.match(/chatTitle\s*[:=]\s*["']([^"']+)["']/i);
    return {
      routing: routingMatch[1] as DispatcherRoute["routing"],
      chatTitle: chatTitleMatch?.[1],
    };
  }
}

function parseDispatcherRoute(value: unknown): DispatcherRoute | null {
  if (!value) return null;

  if (typeof value === "string") {
    return parseDispatcherJson(value);
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
    const nested = parseDispatcherRoute(data[key]);
    if (nested) return nested;
  }

  return null;
}

function App() {

  function activateTab(targetId: string) {
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === targetId ? { ...tab, isActive: true } : { ...tab, isActive: false }
      )
    );
  }

  function addTab(newUrl: string) {
    const isLoadableUrl = !isInternalUrl(newUrl);
    setTabs((currentTabs) => {
      const newTab: Tab = {
        id: crypto.randomUUID(),
        url: newUrl,
        title: "New Tab",
        isActive: true,
        faviconUrl: isLoadableUrl ? guessFaviconUrl(newUrl) : null,
        isLoading: isLoadableUrl,
        history: [newUrl],
        historyIndex: 0,
      };
      return [...currentTabs.map(tab => ({ ...tab, isActive: false })), newTab];
    });
    setAddressBarValue("");
    const addressInput = document.querySelector('.address-input') as HTMLInputElement;
    if (addressInput) {
      addressInput.focus();
    }
  }

  useEffect(() => {
    const handler = () => {
      addTab(NEW_TAB_URL);
    };

    const cleanup = window.api?.onNewTab(handler);
    return cleanup;
  }, []);


  function closeTab(targetId: string) {
    pinchScaleRef.current.delete(targetId);
    setTabs((currentTabs) => {
      const closed = currentTabs.find(tab => tab.id === targetId);
      if (closed) {
        closedTabsRef.current = [closed, ...closedTabsRef.current].slice(0, 10);
      }
      const newTabs = currentTabs.filter(tab => tab.id !== targetId);
      if (newTabs.length > 0) {
        newTabs[newTabs.length - 1].isActive = true;
      }
      return newTabs;
    });
  }

  function reopenClosedTab() {
    const [lastClosed, ...rest] = closedTabsRef.current;
    if (!lastClosed) return;
    closedTabsRef.current = rest;
    setTabs((currentTabs) => [
      ...currentTabs.map(t => ({ ...t, isActive: false })),
      { ...lastClosed, isActive: true },
    ]);
  }

  useEffect(() => {
    const cleanup = window.api?.onReopenClosedTab(reopenClosedTab);
    return () => cleanup?.();
  }, []);

  function recordHistoryVisit(url: string) {
    if (isInternalUrl(url)) return;
    setHistory((prev) => {
      if (prev[0]?.url === url) return prev;
      return [{ url, title: url, visitedAt: Date.now() }, ...prev].slice(0, 500);
    });
  }

  useEffect(() => {
    const handler = () => {
      const activeTab = tabsRef.current.find(tab => tab.isActive);
      if (activeTab) {
        closeTab(activeTab.id);
      }
    };

    const cleanup = window.api?.onCloseActiveTab(handler);
    return cleanup;
  }, []);

  const [tabs, setTabs] = useState<Tab[]>(() => loadPersistedTabs());

  // Keep a ref to always have the current tabs
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_STATE_STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // Ignore storage failures and keep the browser usable.
    }
  }, [tabs]);

  // Expose tabs to the main process via executeJavaScript
  useEffect(() => {
    (window as any).__tabs = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, isActive: t.isActive }));
  }, [tabs]);

  const webviewRefs = useRef<Map<string, HTMLWebViewElement>>(new Map());
  const webviewContainerRef = useRef<HTMLDivElement>(null);
  //maps tab id to webview element inside .current

  // Per-tab CSS scale applied by pinch-to-zoom (see onPinchZoom effect below).
  const pinchScaleRef = useRef<Map<string, number>>(new Map());

  const closeContextMenuRef = useRef<(() => void) | null>(null);

  function showContextMenu(x: number, y: number, items: { label: string; action: () => void; separator?: boolean }[]) {
    if (closeContextMenuRef.current) {
      closeContextMenuRef.current();
    }

    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.zIndex = '9999';
    overlay.style.background = 'transparent';

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.zIndex = '10000';

    const removeMenu = () => {
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
      if (document.body.contains(menu)) {
        document.body.removeChild(menu);
      }
      closeContextMenuRef.current = null;
    };

    closeContextMenuRef.current = removeMenu;

    overlay.addEventListener('mousedown', () => {
      removeMenu();
    });

    overlay.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      removeMenu();
    });

    items.forEach((item) => {
      const menuItem = document.createElement('div');
      menuItem.textContent = item.label;
      menuItem.className = `context-menu-item${item.separator ? ' separator' : ''}`;

      menuItem.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        item.action();
        removeMenu();
      });

      menu.appendChild(menuItem);
    });

    document.body.appendChild(overlay);
    document.body.appendChild(menu);
  }

  function handleTabContextMenu(e: ReactMouseEvent, tab: Tab) {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Duplicate tab', action: () => addTab(tab.url) },
      { label: 'Close tab', action: () => closeTab(tab.id) },
    ]);
  }

  useEffect(() => {
    const currentRefs = webviewRefs.current;

    const handlers = new Map<string, { 
      navigate: (e: any) => void; 
      navigateInPage: (e: any) => void; 
      finishLoad: () => void;
      startLoading: () => void;
      titleUpdated: (e: any) => void;
      faviconUpdated: (e: any) => void;
      contextMenu: (e: any) => void;
      newWindow: (e: any) => void;
    }>();

    tabs.forEach((tab) => {
      const el = currentRefs.get(tab.id);
      if (el) {


        const newWindowHandler = (e: any) => {
          e.preventDefault();
          if (e.url) {
            addTab(e.url);
          }
        };

        const startLoadingHandler = () => {
          setTabs((currentTabs) =>
            currentTabs.map((t) =>
              t.id === tab.id ? { ...t, isLoading: true } : t
            )
          );
        };

        const navigateHandler = (e: any) => {
          updateTabUrl(tab.id, e.url);
          recordHistoryVisit(e.url);
        };
        const navigateInPageHandler = (e: any) => {
          updateTabUrl(tab.id, e.url);
        };
        const finishLoadHandler = () => {
          updateTabUrl(tab.id, (el as any).getURL());
          setTabs((currentTabs) =>
            currentTabs.map((t) =>
              t.id === tab.id ? { ...t, isLoading: false } : t
            )
          );
        };

        const titleUpdatedHandler = (e: any) => {
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
        };

        const faviconUpdatedHandler = (e: any) => {
          const favicons: string[] = Array.isArray(e?.favicons) ? e.favicons : [];
          if (favicons.length === 0) return;
          setTabs((currentTabs) =>
            currentTabs.map((t) =>
              t.id === tab.id ? { ...t, faviconUrl: favicons[0] } : t
            )
          );
        };

        const contextMenuHandler = (e: any) => {
          e.preventDefault();

          const { x, y, linkURL } = e.params;
          const menuItems: { label: string; action: () => void; separator?: boolean }[] = [];

          if (linkURL) {
            menuItems.push({
              label: 'Open link in new tab',
              action: () => addTab(linkURL),
              separator: true
            });
          }

          menuItems.push({
            label: 'Inspect',
            action: () => {
              if (el) {
                (el as any).openDevTools();
              }
            }
          });

          menuItems.push({
            label: 'View Mouse Coordinates',
            action: () => {
              setShowMouseCoords(prev => !prev);
            }
          });

          showContextMenu(x, y, menuItems);
        };

        el.addEventListener('did-start-loading', startLoadingHandler);
        el.addEventListener('did-navigate', navigateHandler);
        el.addEventListener('did-navigate-in-page', navigateInPageHandler);
        el.addEventListener('did-finish-load', finishLoadHandler);
        el.addEventListener('page-title-updated', titleUpdatedHandler);
        el.addEventListener('page-favicon-updated', faviconUpdatedHandler);
        el.addEventListener('context-menu', contextMenuHandler);
        el.addEventListener('new-window', newWindowHandler);

        handlers.set(tab.id, {
          startLoading: startLoadingHandler,
          navigate: navigateHandler,
          navigateInPage: navigateInPageHandler,
          finishLoad: finishLoadHandler,
          titleUpdated: titleUpdatedHandler,
          faviconUpdated: faviconUpdatedHandler,
          contextMenu: contextMenuHandler,
          newWindow: newWindowHandler
        });
      }
    });

    return () => {
      tabs.forEach((tab) => {
        const el = currentRefs.get(tab.id);
        const h = handlers.get(tab.id);
        if (el && h) {
          el.removeEventListener('did-start-loading', h.startLoading);
          el.removeEventListener('did-navigate', h.navigate);
          el.removeEventListener('did-navigate-in-page', h.navigateInPage);
          el.removeEventListener('did-finish-load', h.finishLoad);
          el.removeEventListener('page-title-updated', h.titleUpdated);
          el.removeEventListener('page-favicon-updated', h.faviconUpdated);
          el.removeEventListener('context-menu', h.contextMenu);
          el.removeEventListener('new-window', h.newWindow);
        }
      });
    };
  }, [tabs]);

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
  type ChatMessage = { role: 'user' | 'agent' | 'reply' | 'warning' | 'supervisor'; text: string };
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [agentCursor, setAgentCursor] = useState<{ x: number; y: number } | null>(null);
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantMode, setAssistantMode] = useState<'agent' | 'chat'>('agent');
  // Chat-mode conversation history sent to the conversant backend (separate from
  // chatMessages, which also mixes in agent-mode action steps).
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatStreamingReply, setChatStreamingReply] = useState<string | null>(null);
  const taskSuggestion = useTaskSuggestion();

  type SidebarSession = {
    id: string;
    mode: 'agent' | 'chat';
    title: string;
    messages: ChatMessage[];
    chatHistory: { role: 'user' | 'assistant'; content: string }[];
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
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => crypto.randomUUID());
  const [showSessionHistory, setShowSessionHistory] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_SESSIONS_STORAGE_KEY, JSON.stringify(sidebarSessions));
    } catch {
      // Ignore storage failures and keep the browser usable.
    }
  }, [sidebarSessions]);

  useEffect(() => {
    if (chatMessages.length === 0) return;
    const firstUserMessage = chatMessages.find(m => m.role === 'user')?.text;
    const title = firstUserMessage?.slice(0, 40) || (assistantMode === 'agent' ? 'Agent task' : 'Chat');

    setSidebarSessions(prev => {
      const existing = prev.find(s => s.id === currentSessionId);
      let updated: SidebarSession[];
      if (existing) {
        updated = prev.map(s =>
          s.id === currentSessionId ? { ...s, messages: chatMessages, chatHistory, updatedAt: Date.now() } : s
        );
      } else {
        updated = [
          { id: currentSessionId, mode: assistantMode, title, messages: chatMessages, chatHistory, updatedAt: Date.now() },
          ...prev,
        ];
      }
      updated.sort((a, b) => b.updatedAt - a.updatedAt);
      return updated.slice(0, 100);
    });
  }, [chatMessages]);

  function startNewSidebarSession() {
    setChatMessages([]);
    setChatHistory([]);
    setChatInput("");
    taskSuggestion.clear();
    setCurrentSessionId(crypto.randomUUID());
    setShowSessionHistory(false);
  }

  function openSidebarSession(session: SidebarSession) {
    setChatMessages(session.messages);
    setChatHistory(session.chatHistory);
    setAssistantMode(session.mode);
    setCurrentSessionId(session.id);
    setShowSessionHistory(false);
    taskSuggestion.clear();
  }

  function deleteSidebarSession(sessionId: string) {
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
  const closedTabsRef = useRef<Tab[]>([]);
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
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [isAgentPaused, setIsAgentPaused] = useState(false);
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

  function startAgentRun(taskText: string, contextHistory: { role: 'user' | 'assistant'; content: string }[]) {
    const contextLines = contextHistory
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    const fullInstruction = contextLines
      ? `Context from a prior chat conversation:\n${contextLines}\n\nTask: ${taskText}`
      : taskText;

    // The agent screenshots the active tab's <webview> (or, for a new-tab page, the
    // page itself) to work — it can't do anything useful while a chat/history tab
    // (no webview) is active, e.g. right after a handoff from the Chat tab.
    const activeTab = tabsRef.current.find(t => t.isActive);
    if (activeTab && (isChatUrl(activeTab.url) || isHistoryUrl(activeTab.url))) {
      const existingBrowsableTab = tabsRef.current.find(t => !isChatUrl(t.url) && !isHistoryUrl(t.url));
      if (existingBrowsableTab) {
        activateTab(existingBrowsableTab.id);
      } else {
        addTab(NEW_TAB_URL);
      }
    }

    taskSuggestion.clear();
    setShowAssistant(true);
    setAssistantMode('agent');
    setChatMessages(prev => [...prev, { role: 'agent', text: `Switched to Agent mode for: "${taskText}"` }]);
    setIsAgentRunning(true);
    setIsAgentPaused(false);
    window.api?.runAgentInstruction(fullInstruction);
  }

  async function handleAgentSend() {
    const text = chatInput.trim();
    if (!text) return;
    if (assistantMode === 'chat' && isChatLoading) return;

    setChatInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    if (assistantMode === 'agent') {
      setChatMessages(prev => [...prev, { role: 'user', text }]);
      setIsAgentRunning(true);
      setIsAgentPaused(false);
      window.api?.runAgentInstruction(text);
      return;
    }

    // Chat mode
    const attachedImage = imageAttachment.pendingImage;
    imageAttachment.clear();
    taskSuggestion.clear();
    setChatMessages(prev => [...prev, { role: 'user', text }]);

    const updatedHistory = [...chatHistory, { role: 'user' as const, content: text }];
    setChatHistory(updatedHistory);

    await requestChatReply(updatedHistory, attachedImage?.dataUrl);
    taskSuggestion.suggest(text);
  }

  function handleAgentStop() {
    window.api?.stopAgent();
    setIsAgentRunning(false);
    setIsAgentPaused(false);
    setAgentCursor(null);
  }

  function handleAgentPause() {
    window.api?.pauseAgent();
    setIsAgentPaused(true);
  }

  function handleAgentResume() {
    window.api?.resumeAgent();
    setIsAgentPaused(false);
  }

  useEffect(() => {
    const cleanup = window.api?.onAgentCursorFlash((_event: any, pos: { x: number; y: number }) => {
      setAgentCursor({ x: pos.x, y: pos.y });
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentAction((_event: any, description: string) => {
      setChatMessages(prev => [...prev, { role: 'agent', text: description }]);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentDone((_event: any, answer: string) => {
      setIsAgentRunning(false);
      setIsAgentPaused(false);
      setAgentCursor(null);
      if (answer && answer.trim()) {
        setChatMessages(prev => [...prev, { role: 'reply', text: answer.trim() }]);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentWarn((_event: any, message: string) => {
      if (message && message.trim()) {
        setChatMessages(prev => [...prev, { role: 'warning', text: message.trim() }]);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentSupervisor((_event: any, info: { count: number; limit: number; task: string; refinedPrompt: string | null }) => {
      const text = info.refinedPrompt
        ? `Noticed repeated actions (${info.count}/${info.limit}) — adjusting approach: "${info.refinedPrompt}"`
        : `Noticed repeated actions (${info.count}/${info.limit}) on: "${info.task}"`;
      setChatMessages(prev => [...prev, { role: 'supervisor', text }]);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

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

      // Gaps between tabs (6px each)
      const totalGaps = Math.max(0, tabs.length - 1) * 6;
      
      const availableWidth = windowWidth - reservedSpace - totalGaps;
      
      if (tabs.length > 0) {
        const widthPerTab = availableWidth / tabs.length;
        // Clamp: Max 240px, Min 24px (enough to always keep the favicon visible)
        setTabWidth(Math.min(240, Math.max(24, widthPerTab)));
      }
    };

    calculateTabWidth();
    window.addEventListener('resize', calculateTabWidth);
    return () => window.removeEventListener('resize', calculateTabWidth);
  }, [tabs.length, platform]);

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

  function handleReloadActiveTab() {
    const activeWebview = getActiveWebview();
    if (activeWebview) {
      activeWebview.reload();
    }
  }

  useEffect(() => {
    const cleanup = window.api?.onReloadActiveTab(handleReloadActiveTab);
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onZoomIn(() => {
      const activeWebview = getActiveWebview();
      if (activeWebview) {
        activeWebview.setZoomLevel(activeWebview.getZoomLevel() + 0.5);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onZoomOut(() => {
      const activeWebview = getActiveWebview();
      if (activeWebview) {
        activeWebview.setZoomLevel(activeWebview.getZoomLevel() - 0.5);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onPinchZoom((direction) => {
      const activeTab = tabsRef.current.find((tab) => tab.isActive);
      const activeWebview = activeTab ? webviewRefs.current.get(activeTab.id) : null;
      if (!activeWebview || !activeTab) return;

      const current = pinchScaleRef.current.get(activeTab.id) ?? 1;
      const next = Math.max(0.9, Math.min(2, current * (direction === "in" ? 1.08 : 1 / 1.08)));
      pinchScaleRef.current.set(activeTab.id, next);
      activeWebview.style.transform = next === 1 ? "" : `scale(${next})`;
      activeWebview.style.transformOrigin = "center center";
    });
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

  const [AddressBarValue, setAddressBarValue] = useState("");
  const addressBarFocusedRef = useRef(false);

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
  
  function handleUserAddressBarInput(newValue: string) {
    (document.activeElement as HTMLElement)?.blur();
    const trimmed = newValue.trim();
    if (!trimmed) {
      setAddressBarValue("");
      return;
    }
    let url = trimmed;
    if (!(url.startsWith("http://") || url.startsWith("https://"))) {
      url = "https://www.google.com/search?q=" + encodeURIComponent(url);
    }

    const activeTab = tabsRef.current.find((tab) => tab.isActive);
    if (activeTab && activeTab.url === url) {
      handleReloadActiveTab();
      return;
    }

    navigateActiveTabToUrl(url);
  }

  function navigateActiveTabToUrl(url: string) {
    const targetTabId = activeTabId ?? tabsRef.current.find(tab => tab.isActive)?.id;
    if (!targetTabId) return;
    const isNewTab = isNewTabUrl(url);
    setAddressBarValue(isNewTab ? "" : url);
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

  async function handleNewTabSearch(query: string) {
    setNewTabRoutingError(null);
    try {
      const dispatcherRequest = window.api?.dispatcherRequest?.(query);
      if (!dispatcherRequest) {
        navigateActiveTabToUrl(googleSearchUrl(query));
        return;
      }

      const response = await withTimeout<ApiResponse>(dispatcherRequest, 2000);
      const route = !response?.error ? parseDispatcherRoute(response?.data) : null;

      if (route?.routing === "web-search") {
        navigateActiveTabToUrl(googleSearchUrl(query));
        return;
      }

      const chatUrl = new URL("indus://chat");
      chatUrl.searchParams.set("q", query);
      if (route?.chatTitle?.trim()) {
        chatUrl.searchParams.set("title", route.chatTitle.trim());
      }
      navigateActiveTabToUrl(chatUrl.toString());
    } catch (error) {
      console.error("Dispatcher route failed", error);
      setNewTabRoutingError("Couldn't reach the AI router — showing a web search instead.");
      window.setTimeout(() => setNewTabRoutingError(null), 4000);
      navigateActiveTabToUrl(googleSearchUrl(query));
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

  function updateTabUrl(tabId: string, newUrl: string) {
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id !== tabId
          ? tab
          : (() => {
              const history = tab.history?.length ? tab.history : [tab.url];
              const currentHistoryUrl = history[Math.min(tab.historyIndex, history.length - 1)];

              if (currentHistoryUrl === newUrl) {
                return {
                  ...tab,
                  url: newUrl,
                  faviconUrl: currentHistoryUrl === tab.url ? tab.faviconUrl ?? null : null,
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
    if (!activeTab || activeTab.historyIndex <= 0) return;

    const targetIndex = activeTab.historyIndex - 1;
    const targetUrl = activeTab.history[targetIndex];

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
    const cleanup = window.api?.onAgentNavigate((_event: any, url: string) => {
      if (activeTabId) {
        updateTabUrl(activeTabId, url);
      }
    });
    return () => cleanup?.();
  }, [activeTabId]);


  useEffect(() => {
    const cleanup = window.api?.onAgentNewTab((_event: any, url?: string) => {
      if (url) {
        addTab(url);
      } else {
        addTab(NEW_TAB_URL);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentReloadActiveTab(() => {
      handleReloadActiveTab();
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentCloseActiveTab(() => {
      if (activeTabId) {
        closeTab(activeTabId);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.api?.onAgentSwitchToTab((_event: any, url: string) => {
      const tab = tabsRef.current.find(t => t.url === url);
      if (tab) activateTab(tab.id);
    });
    return () => cleanup?.();
  }, []);

  // Handle new-tab requests from webview guests via main process
  useEffect(() => {
    const cleanup = window.api?.onOpenUrlInNewTab((_event: any, url: string) => {
      if (url) addTab(url);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {
      // Ignore storage failures and keep the browser usable.
    }
  }, [history]);

  useEffect(() => {
    const cleanup = window.api?.onOpenHistory(() => {
      const targetTabId = activeTabId ?? tabsRef.current.find(t => t.isActive)?.id;
      if (targetTabId) updateTabUrl(targetTabId, "indus://history");
    });
    return () => cleanup?.();
  }, [activeTabId]);

  useEffect(() => {
    const cleanup = window.api?.onFocusAddressBar(() => {
      const input = document.querySelector('.address-input') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    });
    return () => cleanup?.();
  }, []);

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

  useEffect(() => {
    const cleanup = window.api?.onFindInPage(() => {
      setShowFindBar(true);
      window.setTimeout(() => findInputRef.current?.focus(), 0);
    });
    return () => cleanup?.();
  }, []);

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
    <div className="app-container dark">
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
      {/* Overlay to capture mouse events during resizing, preventing webview interference */}
      {isResizingSidebar && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            zIndex: 9999,
            cursor: "col-resize",
          }}
        />
      )}

      {/* Tab Bar */}
      <div className="tab-bar">
        {tabs.map((tab) => (
            <div
            key={tab.id}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => handleTabContextMenu(e, tab)}
            className={`tab ${tab.isActive ? "active" : ""}`}
            style={{ width: `${tabWidth}px` }}
            >
            {isInternalUrl(tab.url) ? (
              <img src={logo} alt="" className="tab-favicon" />
            ) : tab.isLoading && !tab.faviconUrl ? (
              <img src={loadingAnimation} className="loading-animation" />
            ) : (
              <img
              src={tab.faviconUrl ? tab.faviconUrl : favicon}
              alt=""
              className="tab-favicon"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = favicon;
              }}
              />
            )}
            <span className="tab-title">
              {tab.title || (isNewTabUrl(tab.url)
                ? "New Tab"
                : tab.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]
              )}
            </span>
            <span
              className="tab-close"
              onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.id);
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <path d="M9,1L1,9M1,1l8,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
            </div>
        ))}
        <button 
          onClick={() => addTab(NEW_TAB_URL)}
          className="new-tab-button"
        >
          +
        </button>

        {/* Window Controls - Windows (right side) */}
        {platform === 'win32' && (
          <div className="window-controls window-controls-windows">
            <button className="win-control" onClick={handleMinimize}>
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4" width="8" height="1" fill="currentColor"/></svg>
            </button>
            <button className="win-control" onClick={handleMaximize}>
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1,1v8h8V1H1z M8,8H2V2h6V8z" fill="currentColor"/></svg>
            </button>
            <button className="win-control win-close" onClick={handleClose}>
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M10,1L9,0L5,4L1,0L0,1l4,4L0,9l1,1l4-4l4,4l1-1L6,5L10,1z" fill="currentColor"/></svg>
            </button>
          </div>
        )}
      </div>

      {/* Toolbar & Address Bar */}
      <div className="toolbar">
        {/* Navigation Controls */}
        <div className="nav-controls">
          <button className="nav-button" onClick={goBack}><img src={backIcon} alt="Back" /></button>
          <button className="nav-button" onClick={goForward}><img src={forwardIcon} alt="Forward" /></button>
          <button className="nav-button" onClick={handleReloadActiveTab}><img src={refreshIcon} alt="Refresh" /></button>
        </div>

        {/* Address Bar */}
        <div className="address-bar">
          <span className="address-search-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" fill="none" />
              <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <input 
            type="text" 
            value={AddressBarValue} 
            onChange={(e) => setAddressBarValue(e.target.value)}
            className="address-input" 
            onFocus={() => {
              addressBarFocusedRef.current = true;
            }}
            onBlur={(e) => {
              addressBarFocusedRef.current = false;
              handleUserAddressBarInput(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleUserAddressBarInput(e.currentTarget.value);
              }
            }}
          />
        </div>

        {/* Right Side Icons */}
        <div className="toolbar-right">
          <button 
            className={`icon-button agent-button ${showAssistant ? "active" : ""}`} 
            title="Agent" 
            onClick={() => setShowAssistant(!showAssistant)}
          >
            <img src={logo} alt="" className="assistant-icon" />Agent
          </button>
        </div>
      </div>

      {/* Webview Container */}
      <div className="webview-container" ref={webviewContainerRef}>
        {tabs.map((tab) => {
          if (isNewTabUrl(tab.url)) {
            return (
              <div
                key={tab.id}
                className="new-tab-shell"
                style={{ display: tab.isActive ? "flex" : "none" }}
              >
                <NewTabPage
                  displayName="npsboy"
                  onSearch={handleNewTabSearch}
                  routingError={newTabRoutingError}
                  onOpenChat={() => updateTabUrl(tab.id, "indus://chat")}
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
                  onOpenUrl={(url) => addTab(url)}
                  onClear={() => setHistory([])}
                  onClose={() => updateTabUrl(tab.id, NEW_TAB_URL)}
                />
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
                src={tab.url}
                partition="persist:indus-browser"
                // @ts-ignore
                allowpopups="true"
                style={{ 
                  flex: 1, height: "100%",
                  display: tab.isActive ? "flex" : "none"
                }}
              />
            );
          }
        })}

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
                }
              }}
              placeholder="Find in page"
            />
            <span className="find-bar-count">
              {findMatches ? `${findMatches.matches > 0 ? findMatches.activeMatch : 0}/${findMatches.matches}` : ""}
            </span>
            <button type="button" className="find-bar-nav" onClick={() => performFind(findQuery, false, true)} aria-label="Previous match">‹</button>
            <button type="button" className="find-bar-nav" onClick={() => performFind(findQuery, true, true)} aria-label="Next match">›</button>
            <button type="button" className="find-bar-close" onClick={closeFindBar} aria-label="Close find bar">×</button>
          </div>
        )}

        {downloads.length > 0 && (
          <div className="download-toast-list">
            {downloads.map((d) => (
              <div
                key={d.id}
                className={`download-toast${d.done ? (d.success ? ' download-toast-done' : ' download-toast-failed') : ''}`}
                onClick={() => d.done && d.success && d.path && window.api?.showItemInFolder(d.path)}
              >
                <span className="download-toast-name">{d.filename}</span>
                <span className="download-toast-status">
                  {!d.done ? (d.percent != null ? `${d.percent}%` : "Downloading…") : d.success ? "Done" : "Failed"}
                </span>
              </div>
            ))}
          </div>
        )}

        {showAssistant && (
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
              <span className="assistant-sidebar-title">{assistantMode === 'agent' ? 'Agent' : 'Chat'}</span>
              <div className="assistant-sidebar-top-actions">
                <button
                  type="button"
                  className="assistant-icon-btn"
                  title="New session"
                  aria-label="New session"
                  onClick={startNewSidebarSession}
                  disabled={isAgentRunning}
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
            {showSessionHistory ? (
              <div className="assistant-session-history">
                {sidebarSessions.filter(s => s.mode === assistantMode).length === 0 ? (
                  <div className="assistant-session-empty">No {assistantMode === 'agent' ? 'agent' : 'chat'} sessions yet.</div>
                ) : (
                  sidebarSessions
                    .filter(s => s.mode === assistantMode)
                    .map(session => (
                      <div
                        key={session.id}
                        className={`assistant-session-item${session.id === currentSessionId ? ' active' : ''}`}
                        onClick={() => openSidebarSession(session)}
                      >
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
                  <h2>{assistantMode === 'agent' ? 'Agent' : 'Chat'}</h2>
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
                      if (msg.role === 'supervisor') {
                        return (
                          <div key={i} className="chat-message chat-message-supervisor">
                            <span className="chat-bubble chat-bubble-supervisor">{msg.text}</span>
                          </div>
                        );
                      }
                      return (
                        <div key={i} className="chat-message chat-message-warning">
                          <span className="chat-bubble chat-bubble-warning">{msg.text}</span>
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
              {assistantMode === 'chat' && chatStreamingReply !== null && (
                <div className="chat-message chat-message-reply">
                  <div className="chat-reply-header">
                    <img src={logo} alt="Indus" className="agent-action-logo" />
                  </div>
                  <div className="chat-bubble chat-bubble-reply markdown-content">
                    <ReactMarkdown>{chatStreamingReply}</ReactMarkdown>
                  </div>
                </div>
              )}
              {assistantMode === 'chat' && isChatLoading && chatStreamingReply === null && (
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
                    onClick={() => startAgentRun(taskSuggestion.pendingTaskSuggestion!, chatHistory)}
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
                </div>
              )}
              {assistantMode === 'chat' && imageAttachment.pendingImage && (
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
              {assistantMode === 'chat' && imageAttachment.error && (
                <div className="pending-attachment-error">{imageAttachment.error}</div>
              )}
              <div className="assistant-input-row">
                <textarea
                  ref={textareaRef}
                  placeholder={assistantMode === 'agent' ? "Assign any task..." : "Ask anything..."} 
                  className="assistant-text-input"
                  autoFocus
                  rows={1}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onInput={handleInputResize}
                  onPaste={assistantMode === 'chat' ? imageAttachment.handlePaste : undefined}
                  onDrop={assistantMode === 'chat' ? imageAttachment.handleDrop : undefined}
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
                    disabled={assistantMode === 'chat' && isChatLoading}
                  >
                    ➤
                  </button>
                )}
              </div>
              <div className="assistant-input-footer">
                {assistantMode === 'chat' && (
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
                    {assistantMode === 'agent' ? 'Agent' : 'Chat'}
                    <span className="dropdown-icon" aria-hidden="true">
                      <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </button>
                  
                  {showAssistantMenu && (
                    <div className="assistant-mode-menu">
                      <div 
                        className="assistant-mode-item" 
                        onClick={() => { setAssistantMode('agent'); setShowAssistantMenu(false); }}
                      >
                        Agent
                      </div>
                      <div 
                        className="assistant-mode-item" 
                        onClick={() => { setAssistantMode('chat'); setShowAssistantMenu(false); }}
                      >
                        Chat
                      </div>
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
