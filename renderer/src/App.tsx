import { useState, useEffect, useRef } from "react";
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

const NEW_TAB_URL = "indus://newtab";
const TAB_STATE_STORAGE_KEY = "indus-browser.tabs.v1";
const isNewTabUrl = (url: string) => url === NEW_TAB_URL;
const isChatUrl = (url: string) => url.startsWith("indus://chat");

function getFaviconUrl(pageUrl: string) {
  try {
    if (isNewTabUrl(pageUrl) || isChatUrl(pageUrl)) {
      return null;
    }
    const u = new URL(pageUrl);
    return u.origin + "/favicon.ico";
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
        faviconUrl: typeof tab?.faviconUrl === "string" || tab?.faviconUrl === null ? tab.faviconUrl : null,
        isLoading: Boolean(tab?.isLoading),
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

function App() {

  function activateTab(targetId: string) {
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === targetId ? { ...tab, isActive: true } : { ...tab, isActive: false }
      )
    );
  }

  function addTab(newUrl: string) {
    const isNewTab = isNewTabUrl(newUrl);
    setTabs((currentTabs) => {
      const newTab: Tab = {
        id: crypto.randomUUID(),
        url: newUrl,
        title: "New Tab",
        isActive: true,
        faviconUrl: null,
        isLoading: !isNewTab,
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

    const cleanup = (window as any).api?.onNewTab(handler);
    return cleanup;
  }, []);


  function closeTab(targetId: string) {
    setTabs((currentTabs) => {
      const newTabs = currentTabs.filter(tab => tab.id !== targetId);
      if (newTabs.length > 0) {
        newTabs[newTabs.length - 1].isActive = true;
      }
      return newTabs;
    });
  }

  useEffect(() => {
    const handler = () => {
      const activeTab = tabsRef.current.find(tab => tab.isActive);
      if (activeTab) {
        closeTab(activeTab.id);
      }
    };

    const cleanup = (window as any).api?.onCloseActiveTab(handler);
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

  const closeContextMenuRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const currentRefs = webviewRefs.current;
    
    const handlers = new Map<string, { 
      navigate: (e: any) => void; 
      navigateInPage: (e: any) => void; 
      finishLoad: () => void;
      startLoading: () => void;
      titleUpdated: (e: any) => void;
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
        };

        const contextMenuHandler = (e: any) => {
          e.preventDefault();
          
          // Remove any existing menu first
          if (closeContextMenuRef.current) {
            closeContextMenuRef.current();
          }

          const { x, y, linkURL } = e.params;

          // Create overlay to catch clicks outside
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

          // Close on click outside (clicking the overlay)
          overlay.addEventListener('mousedown', () => {
            removeMenu();
          });
          
          // Prevent default context menu on overlay and close custom menu
          overlay.addEventListener('contextmenu', (evt) => {
             evt.preventDefault();
             removeMenu();
          });

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

          menuItems.forEach((item) => {
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
        };

        el.addEventListener('did-start-loading', startLoadingHandler);
        el.addEventListener('did-navigate', navigateHandler);
        el.addEventListener('did-navigate-in-page', navigateInPageHandler);
        el.addEventListener('did-finish-load', finishLoadHandler);
        el.addEventListener('page-title-updated', titleUpdatedHandler);
        el.addEventListener('context-menu', contextMenuHandler);
        el.addEventListener('new-window', newWindowHandler);

        handlers.set(tab.id, {
          startLoading: startLoadingHandler,
          navigate: navigateHandler,
          navigateInPage: navigateInPageHandler,
          finishLoad: finishLoadHandler,
          titleUpdated: titleUpdatedHandler,
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
  type ChatMessage = { role: 'user' | 'agent' | 'reply'; text: string };
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [agentCursor, setAgentCursor] = useState<{ x: number; y: number } | null>(null);
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantMode, setAssistantMode] = useState<'agent' | 'chat'>('agent');
  const [showAssistantMenu, setShowAssistantMenu] = useState(false);
  const [platform, setPlatform] = useState<'win32' | 'darwin' | 'linux'>('win32');
  const [tabWidth, setTabWidth] = useState(240);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [isAgentPaused, setIsAgentPaused] = useState(false);

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

  function handleAgentSend() {
    const text = chatInput.trim();
    if (!text) return;
    setChatMessages(prev => [...prev, { role: 'user', text }]);
    setChatInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setIsAgentRunning(true);
    setIsAgentPaused(false);
    (window as any).api?.runAgentInstruction(text);
  }

  function handleAgentStop() {
    (window as any).api?.stopAgent();
    setIsAgentRunning(false);
    setIsAgentPaused(false);
  }

  function handleAgentPause() {
    (window as any).api?.pauseAgent();
    setIsAgentPaused(true);
  }

  function handleAgentResume() {
    (window as any).api?.resumeAgent();
    setIsAgentPaused(false);
  }

  useEffect(() => {
    const cleanup = (window as any).api?.onAgentCursorFlash((_event: any, pos: { x: number; y: number }) => {
      setAgentCursor({ x: pos.x, y: pos.y });
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = (window as any).api?.onAgentAction((_event: any, description: string) => {
      setChatMessages(prev => [...prev, { role: 'agent', text: description }]);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = (window as any).api?.onAgentDone((_event: any, answer: string) => {
      setIsAgentRunning(false);
      setIsAgentPaused(false);
      if (answer && answer.trim()) {
        setChatMessages(prev => [...prev, { role: 'reply', text: answer.trim() }]);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = (window as any).api?.onAgentWarn((_event: any, message: string) => {
      if (message && message.trim()) {
        setChatMessages(prev => [...prev, { role: 'reply', text: `⚠️ ${message.trim()}` }]);
      }
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
        // Clamp: Max 240px, Min 30px
        setTabWidth(Math.min(240, Math.max(3, widthPerTab)));
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

  function handleReloadActiveTab() {
    const activeWebview = document.querySelector('webview[style*="display: flex"]') as any;
    if (activeWebview) {
      activeWebview.reload();
    }
  }

  useEffect(() => {
    (window as any).api?.onReloadActiveTab(handleReloadActiveTab);
  }, []);

  function handleMinimize() {
    if ((window as any).api?.minimizeWindow) {
      (window as any).api.minimizeWindow();
    }
  }

  function handleMaximize() {
    if ((window as any).api?.maximizeWindow) {
      (window as any).api.maximizeWindow();
    }
  }

  function handleClose() {
    if ((window as any).api?.closeWindow) {
      (window as any).api.closeWindow();
    }
  }

  const [AddressBarValue, setAddressBarValue] = useState("");

  useEffect(() => {
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
                isLoading: !isNewTab,
                faviconUrl: isNewTab ? null : getFaviconUrl(url),
                history: nextHistory,
                historyIndex: nextHistory.length - 1,
              };
            })()
      )
    );
  }

  function handleNewTabSearch(query: string) {
    const searchUrl = "indus://chat?q=" + encodeURIComponent(query);
    navigateActiveTabToUrl(searchUrl);
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
                  faviconUrl: isNewTabUrl(newUrl) ? null : getFaviconUrl(newUrl),
                };
              }

              const nextHistory = history.slice(0, Math.max(0, tab.historyIndex + 1));
              nextHistory.push(newUrl);

              return {
                ...tab,
                url: newUrl,
                faviconUrl: isNewTabUrl(newUrl) ? null : getFaviconUrl(newUrl),
                history: nextHistory,
                historyIndex: nextHistory.length - 1,
              };
            })()
      )
    );
    const activeTab = tabsRef.current.find(t => t.isActive);
    if (activeTab && activeTab.id === tabId) {
      setAddressBarValue(isNewTabUrl(newUrl) ? "" : newUrl);
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
              isLoading: true,
              faviconUrl: isNewTabUrl(targetUrl) ? null : getFaviconUrl(targetUrl),
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
              isLoading: true,
              faviconUrl: isNewTabUrl(targetUrl) ? null : getFaviconUrl(targetUrl),
            }
          : tab
      )
    );
  }


  useEffect(() => {
    const cleanup = (window as any).api?.onAgentNavigate((_event: any, url: string) => {
      if (activeTabId) {
        updateTabUrl(activeTabId, url);
      }
    });
    return () => cleanup?.();
  }, [activeTabId]);


  useEffect(() => {
    const cleanup = (window as any).api?.onAgentNewTab((_event: any, url?: string) => {
      if (url) {
        addTab(url);
      } else {
        addTab(NEW_TAB_URL);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = (window as any).api?.onAgentReloadActiveTab(() => {
      handleReloadActiveTab();
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = (window as any).api?.onAgentCloseActiveTab(() => {
      if (activeTabId) {
        closeTab(activeTabId);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = (window as any).api?.onAgentSwitchToTab((_event: any, url: string) => {
      const tab = tabsRef.current.find(t => t.url === url);
      if (tab) activateTab(tab.id);
    });
    return () => cleanup?.();
  }, []);

  // Handle new-tab requests from webview guests via main process
  useEffect(() => {
    const cleanup = (window as any).api?.onOpenUrlInNewTab((_event: any, url: string) => {
      if (url) addTab(url);
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
          onClick={() => setShowMouseCoords(false)}
          style={{
            position: 'fixed',
            top: '12px',
            right: '12px',
            zIndex: 99999,
            background: 'rgba(20, 20, 20, 0.92)',
            color: '#e0e0e0',
            fontFamily: 'monospace',
            fontSize: '13px',
            padding: '6px 12px',
            borderRadius: '6px',
            border: '1px solid rgba(255,255,255,0.15)',
            cursor: 'pointer',
            userSelect: 'none',
            backdropFilter: 'blur(4px)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            pointerEvents: 'all',
          }}
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
            className={`tab ${tab.isActive ? "active" : ""}`}
            style={{ width: `${tabWidth}px` }}
            >
            {tab.isLoading ? (
              <img src={loadingAnimation} className="loading-animation" />
            ) : (
              <img
              src={tab.faviconUrl ? tab.faviconUrl : (isNewTabUrl(tab.url) ? logo : favicon)}
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
            onBlur={(e) => handleUserAddressBarInput(e.target.value)}
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
                <NewTabPage displayName="npsboy" onSearch={handleNewTabSearch} />
              </div>
            );
          } else if (isChatUrl(tab.url)) {
            return (
              <div
                key={tab.id}
                className="chat-page-shell"
                style={{ display: tab.isActive ? "flex" : "none", flex: 1, width: "100%", height: "100%" }}
              >
                <ChatPage tabId={tab.id} initialUrl={tab.url} onUrlChange={(newUrl) => updateTabUrl(tab.id, newUrl)} />
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
            <div className="assistant-messages">
              {chatMessages.length === 0 ? (
                <div className="assistant-empty-state">
                  <img src={logo} alt="Agent" className="agent-logo-large" />
                  <h2>{assistantMode === 'agent' ? 'Agent' : 'Chat'}</h2>
                </div>
              ) : (
                chatMessages.map((msg, i) => {
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
                  const isFirst = i === 0 || chatMessages[i - 1].role !== 'agent';
                  const isLast = i === chatMessages.length - 1 || chatMessages[i + 1].role !== 'agent';
                  return (
                    <div key={i} className={`agent-action-item${isFirst ? ' agent-action-first' : ''}${isLast ? ' agent-action-last' : ''}`}>
                      {isFirst && (
                        <div className="agent-action-header">
                          <img src={logo} alt="Indus" className="agent-action-logo" />
                        </div>
                      )}
                      <div className="agent-action-step">
                        <div className="agent-action-line-wrap">
                          <div className="agent-action-dot" />
                          <div className="agent-action-connector" />
                        </div>
                        <div className="agent-action-text markdown-content">
                          <ReactMarkdown>{msg.text}</ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>
            
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
                  <button className="assistant-send-button" onClick={handleAgentSend}>➤</button>
                )}
              </div>
              <div className="assistant-input-footer">
                <button className="assistant-attach-button" title="Attach file">
                  <span>📎</span>
                </button>
                
                <div style={{ position: 'relative' }}>
                  <button 
                    className="assistant-mode-button" 
                    onClick={() => setShowAssistantMenu(!showAssistantMenu)}
                  >
                    {assistantMode === 'agent' ? 'Agent' : 'Chat'} <span>⌄</span>
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
