import { useState, useEffect, useRef, use } from "react";
import "./App.css";
import logo from "./assets/logos/Logo-White.png";
import favicon from "./assets/logos/Favicon.png";
import backIcon from "./assets/Icons/Back-Grey.png";
import forwardIcon from "./assets/Icons/Forward-Grey.png";
import refreshIcon from "./assets/Icons/Refresh-Grey.png";
import bookmarkIcon from "./assets/Icons/Bookmark-Grey.png";
import linkIcon from "./assets/Icons/Link-Grey.png";
import workflowIcon from "./assets/Icons/Workflow-Grey.png";
import extensionIcon from "./assets/Icons/Extension-White.png";
import dropdownIcon from "./assets/Icons/Dropdown-White.png";
import minimizeIcon from "./assets/Icons/Minimize-Grey.png";
import maximizeIcon from "./assets/Icons/Maximize-Grey.png";
import closeIcon from "./assets/Icons/Close-Grey.png";
import profilePic from "./assets/Images/Profile-Pictures/Profile-Picture-1.jpg";
import loadingAnimation from "./assets/Icons/loading-animation.gif";

function App() {

  type Tab = {
    id: string;
    url: string;
    title?: string;
    isActive: boolean;
    faviconUrl?: string | null;
    isLoading?: boolean;
  };

  function activateTab(targetId: string) {
    let newTabs = tabs.map(tab =>
    tab.id === targetId
      ? { ...tab, isActive: true }
      : { ...tab, isActive: false }
    );
    setTabs(newTabs);
  }

  function addTab(newUrl: string) {
    setTabs((currentTabs) => {
      const newTab: Tab = {
        id: crypto.randomUUID(),
        url: newUrl,
        title: "New Tab",
        isActive: true,
        faviconUrl: null,
        isLoading: true
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
      addTab("https://google.com");
    };

    const cleanup = (window as any).api?.onNewTab(handler);
    return cleanup;
  }, []);

  // Set up agent task listener
  useEffect(() => {
    console.log('[App.tsx] Setting up agent task listener...');
    const agentapi = (window as any).agentapi;
    if (agentapi?.onAgentTask) {
      console.log('[App.tsx] Agent task listener registered!');
      const cleanup = agentapi.onAgentTask((task: string, screenshot: string) => {
        console.log('[App.tsx] ========================================');
        console.log('[App.tsx] RECEIVED TASK FROM MAIN PROCESS!');
        console.log('[App.tsx] Task:', task);
        console.log('[App.tsx] Screenshot received:', screenshot ? 'Yes' : 'No');
        console.log('[App.tsx] ========================================');
      });
      return cleanup;
    } else {
      console.warn('[App.tsx] agentapi.onAgentTask not available!');
    }
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

  const [tabs, setTabs] = useState<Tab[]>([
    { id: "1Kw345fg178", url: "https://example.com", isActive: false, title: "Example" },
    { id: "2witsnghfiw", url: "https://github.com", isActive: true, title: "GitHub" },
  ]);

  // Keep a ref to always have the current tabs
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const webviewRefs = useRef<Map<string, HTMLWebViewElement>>(new Map());
  //maps tab id to webview element inside .current

  const closeContextMenuRef = useRef<(() => void) | null>(null);
  const [showCoordinates, setShowCoordinates] = useState(false);
  const [mouseCoordinates, setMouseCoordinates] = useState({ x: 0, y: 0 });

  // Live mouse tracking for coordinates display
  useEffect(() => {
    if (!showCoordinates) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Calculate coordinates relative to the entire app, not just webview
      setMouseCoordinates({ 
        x: Math.round(e.clientX), 
        y: Math.round(e.clientY) 
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [showCoordinates]);

  useEffect(() => {
    const currentRefs = webviewRefs.current;
    
    const handlers = new Map<string, { 
      domReady: () => void;
      navigate: (e: any) => void; 
      navigateInPage: (e: any) => void; 
      finishLoad: () => void;
      startLoading: () => void;
      newWindow: (e: any) => void;
      titleUpdated: (e: any) => void;
      contextMenu: (e: any) => void;
    }>();

    tabs.forEach((tab) => {
      const el = currentRefs.get(tab.id);
      if (el) {


        const domReadyHandler = () => {
          (el as any).setWindowOpenHandler((details: any) => {
            addTab(details.url);
            return { action: "deny" };
          });
        }

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

        function newWindowHandler(e: any) {
          alert("Opening new windows is disabled in this browser.");
          e.preventDefault();
          addTab(e.url);
        }

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
            label: 'Pointer Coordinates',
            action: () => {
              setMouseCoordinates({ x, y });
              setShowCoordinates(true);
            }
          });

          menuItems.push({
            label: 'Inspect',
            action: () => {
              if (el) {
                (el as any).openDevTools();
              }
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
        el.addEventListener('new-window', newWindowHandler);
        el.addEventListener('page-title-updated', titleUpdatedHandler);
        el.addEventListener('context-menu', contextMenuHandler);

        el.addEventListener('dom-ready', domReadyHandler);

        handlers.set(tab.id, {
          startLoading: startLoadingHandler,
          navigate: navigateHandler,
          navigateInPage: navigateInPageHandler,
          finishLoad: finishLoadHandler,
          newWindow: newWindowHandler,
          titleUpdated: titleUpdatedHandler,
          contextMenu: contextMenuHandler,
          domReady: domReadyHandler
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
          el.removeEventListener('new-window', h.newWindow);
          el.removeEventListener('page-title-updated', h.titleUpdated);
          el.removeEventListener('context-menu', h.contextMenu);
        }
      });
    };
  }, [tabs]);

  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantMode, setAssistantMode] = useState<'agent' | 'chat'>('agent');
  const [showAssistantMenu, setShowAssistantMenu] = useState(false);
  const [platform, setPlatform] = useState<'win32' | 'darwin' | 'linux'>('win32');
  const [tabWidth, setTabWidth] = useState(240);

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
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  useEffect(() => {
    const calculateTabWidth = () => {
      const windowWidth = window.innerWidth;
      let reservedSpace = 0;
      
      // Padding (6px left + 6px right)
      reservedSpace += 12;
      
      // New tab button (approx 40px)
      reservedSpace += 40;

      // Platform specific controls
      if (platform === 'darwin') {
        reservedSpace += 80; // ~72px + buffer
      } else if (platform === 'win32') {
        reservedSpace += 150; // ~138px + buffer
      }

      // Extra safety buffer
      reservedSpace += 20;

      // Gaps between tabs (2px each)
      const totalGaps = Math.max(0, tabs.length - 1) * 2;
      
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

  function toggleTheme() {
    setIsDarkTheme(!isDarkTheme);
  }

  function handleMinimize() {
    if (window.api?.minimizeWindow) {
      window.api.minimizeWindow();
    }
  }

  function handleMaximize() {
    if (window.api?.maximizeWindow) {
      window.api.maximizeWindow();
    }
  }

  function handleClose() {
    if (window.api?.closeWindow) {
      window.api.closeWindow();
    }
  }

  const [AddressBarValue, setAddressBarValue] = useState("");

  useEffect(() => {
    const activeTab = tabs.find(t => t.isActive);
    if (activeTab) {
      if (activeTab.url !== "https://www.google.com/"){
        setAddressBarValue(activeTab.url);
      } else {
        setAddressBarValue("");
      }
    }
  }, [tabs]);
  
  function handleUserAddressBarInput(newValue: string) {
    (document.activeElement as HTMLElement)?.blur();
    if (!(newValue.startsWith("http://") || newValue.startsWith("https://"))) {
      newValue = "https://www.google.com/search?q=" + encodeURIComponent(newValue);
    }
    setAddressBarValue(newValue);
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.isActive ? { ...tab, url: newValue } : tab
      )
    );
  }

  function updateTabUrl(tabId: string, newUrl: string) {
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === tabId ? { ...tab, url: newUrl } : tab
      )
    );
    // Update address bar if this is the active tab
    const activeTab = tabsRef.current.find(t => t.isActive);
    if (activeTab && activeTab.id === tabId) {
      setAddressBarValue(newUrl);
    }

    setTabs((currentTabs) =>
      currentTabs.map((tab) => ({
        ...tab, faviconUrl: getFaviconUrl(tab.url)
      })))

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
    if (!activeTabId) return;

    const webview = webviewRefs.current.get(activeTabId);
    if (webview && (webview as any).canGoBack()) {
      (webview as any).goBack();
    }
  }

  function goForward() {
    if (!activeTabId) return;

    const webview = webviewRefs.current.get(activeTabId);
    if (webview && (webview as any).canGoForward()) {
      (webview as any).goForward();
    }
  }



  function getFaviconUrl(pageUrl: string) {
    try {
      var u = new URL(pageUrl);
      return u.origin + "/favicon.ico";
    } catch {
      return null;
    }
  }


  useEffect(() => {
    (window as any).api?.onAgentNavigate((_event: any, url: string) => {
      if (activeTabId) {
        updateTabUrl(activeTabId, url);
      }
    });
  }, [activeTabId]);


  useEffect(() => {
    (window as any).api?.onAgentNewTab((_event: any, url?: string) => {
      if (url) {
        addTab(url);
      } else {
        addTab("https://www.google.com");
      }
    });
  }, []);

  useEffect(() => {
    (window as any).api?.onAgentReloadActiveTab(() => {
      handleReloadActiveTab();
    });
  }, []);

  useEffect(() => {
    (window as any).api?.onAgentCloseActiveTab(() => {
      if (activeTabId) {
        closeTab(activeTabId);
      }
    });
  }, []);

  return (
    <div className={`app-container ${isDarkTheme ? "dark" : ""}`}>
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
        {/* Window Controls - Mac (left side) */}
        {platform === 'darwin' && (
          <div className="window-controls window-controls-mac">
            <button className="mac-control mac-close" onClick={handleClose}></button>
            <button className="mac-control mac-minimize" onClick={handleMinimize}></button>
            <button className="mac-control mac-maximize" onClick={handleMaximize}></button>
          </div>
        )}

        {tabs.map((tab, idx) => (
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
              src={tab.faviconUrl ? tab.faviconUrl : favicon}
              alt=""
              className="tab-favicon"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = favicon;
              }}
              />
            )}
            <span className="tab-title">
              {tab.title || tab.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}
            </span>
            <span
              className="tab-close"
              onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.id);
              }}
            >
              ×
            </span>
            </div>
        ))}
        <button 
          onClick={() => addTab("https://google.com")}
          className="new-tab-button"
        >
          +
        </button>

        {/* Window Controls - Windows (right side) */}
        {platform === 'win32' && (
          <div className="window-controls window-controls-windows">
            <button className="win-control" onClick={handleMinimize}>
              <img src={minimizeIcon} alt="Minimize" />
            </button>
            <button className="win-control" onClick={handleMaximize}>
              <img src={maximizeIcon} alt="Maximize" />
            </button>
            <button className="win-control win-close" onClick={handleClose}>
              <img src={closeIcon} alt="Close" />
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
          <img src={favicon} alt="" className="address-favicon" />
          <input 
            type="text" 
            placeholder="Ask anything or navigate..."
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
          <div className="address-actions">
            <button className="address-action" title="Bookmark">
              <img src={bookmarkIcon} alt="Bookmark" />
            </button>
            <button className="address-action" title="Copy Link">
              <img src={linkIcon} alt="Link" />
            </button>
          </div>
        </div>

        {/* Right Side Icons */}
        <div className="toolbar-right">
          <button className="icon-button workflow-button" title="Workflows">
            <img src={workflowIcon} alt="Workflows" />
            <span>Workflows</span>
          </button>
          <button 
            className={`icon-button ${showAssistant ? "active" : ""}`} 
            title="Assistant" 
            onClick={() => setShowAssistant(!showAssistant)}
          >
            <img src={logo} alt="" className="assistant-icon" />Assistant
          </button>
          <button className="icon-button"><img src={extensionIcon} alt="Extensions" /></button>
          <div style={{ position: "relative" }}>
            <button className="icon-button" onClick={() => setShowMenu(!showMenu)}>
              <img src={dropdownIcon} alt="Menu" />
            </button>
            {showMenu && (
              <div className="dropdown-menu">
                <div className="menu-item" onClick={() => { toggleTheme(); setShowMenu(false); }}>
                  {isDarkTheme ? "☀️" : "🌙"} {isDarkTheme ? "Light" : "Dark"} Theme
                </div>
              </div>
            )}
          </div>
          <img src={profilePic} alt="Profile" className="profile-pic" />
        </div>
      </div>

      {/* Webview Container */}
      <div className="webview-container">
        {tabs.map((tab) => (
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
            style={{ 
              flex: 1, height: "100%",
              display: tab.isActive ? "flex" : "none"
            }}
          />  
        ))}

        {showCoordinates && (
          <div 
            className="coordinates-display"
            onClick={() => setShowCoordinates(false)}
            style={{
              position: 'absolute',
              top: '20px',
              right: '20px',
              background: 'rgba(0, 0, 0, 0.85)',
              color: 'white',
              padding: '15px 20px',
              borderRadius: '8px',
              zIndex: 10001,
              fontSize: '14px',
              fontFamily: 'monospace',
              cursor: 'pointer',
              userSelect: 'text',
              pointerEvents: 'none'
            }}
          >
            <div>X: {mouseCoordinates.x}</div>
            <div>Y: {mouseCoordinates.y}</div>
            <div style={{ fontSize: '11px', marginTop: '8px', opacity: 0.7, pointerEvents: 'auto' }}>
              Right-click to close
            </div>
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
            <div className="assistant-empty-state">
              <img src={logo} alt="Agent" className="agent-logo-large" />
              <h2>{assistantMode === 'agent' ? 'Agent' : 'Chat'}</h2>
            </div>
            
            <div className="assistant-input-container">
              <div className="assistant-input-row">
                <textarea 
                  ref={textareaRef}
                  placeholder={assistantMode === 'agent' ? "Assign any task..." : "Ask anything..."} 
                  className="assistant-text-input" 
                  autoFocus 
                  rows={1}
                  onInput={handleInputResize}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      const message = textareaRef.current?.value.trim();
                      if (message) {
                        console.log('[App.tsx] Sending message to agent:', message);
                        (window as any).agentapi?.executeTask(message);
                        if (textareaRef.current) {
                          textareaRef.current.value = '';
                          textareaRef.current.style.height = 'auto';
                        }
                      }
                    }
                  }}
                />
                <button 
                  className="assistant-send-button"
                  onClick={() => {
                    const message = textareaRef.current?.value.trim();
                    if (message) {
                      console.log('[App.tsx] Sending message to agent:', message);
                      (window as any).agentapi?.executeTask(message);
                      if (textareaRef.current) {
                        textareaRef.current.value = '';
                        textareaRef.current.style.height = 'auto';
                      }
                    }
                  }}
                >➤</button>
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
