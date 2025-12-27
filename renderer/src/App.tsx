import { useState, useEffect, useRef } from "react";
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

function App() {

  type Tab = {
    id: string;
    url: string;
    isActive: boolean;
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
        isActive: true
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
    { id: "1Kw345fg178", url: "https://example.com", isActive: false},
    { id: "2witsnghfiw", url: "https://github.com", isActive: true },
  ]);

  // Keep a ref to always have the current tabs
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const webviewRefs = useRef<Map<string, HTMLWebViewElement>>(new Map());
  //maps tab id to webview element inside .current

  useEffect(() => {
    const currentRefs = webviewRefs.current;
    
    const handlers = new Map<string, { navigate: (e: any) => void; navigateInPage: (e: any) => void; finishLoad: () => void }>();

    tabs.forEach((tab) => {
      const el = currentRefs.get(tab.id);
      if (el) {
        const navigateHandler = (e: any) => {
          updateTabUrl(tab.id, e.url);
        };
        const navigateInPageHandler = (e: any) => {
          updateTabUrl(tab.id, e.url);
        };
        const finishLoadHandler = () => {
          updateTabUrl(tab.id, (el as any).getURL());
        };

        el.addEventListener('did-navigate', navigateHandler);
        el.addEventListener('did-navigate-in-page', navigateInPageHandler);
        el.addEventListener('did-finish-load', finishLoadHandler);

        handlers.set(tab.id, {
          navigate: navigateHandler,
          navigateInPage: navigateInPageHandler,
          finishLoad: finishLoadHandler
        });
      }
    });

    return () => {
      tabs.forEach((tab) => {
        const el = currentRefs.get(tab.id);
        const h = handlers.get(tab.id);
        if (el && h) {
          el.removeEventListener('did-navigate', h.navigate);
          el.removeEventListener('did-navigate-in-page', h.navigateInPage);
          el.removeEventListener('did-finish-load', h.finishLoad);
        }
      });
    };
  }, [tabs]);

  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [platform, setPlatform] = useState<'win32' | 'darwin' | 'linux'>('win32');
  const [tabWidth, setTabWidth] = useState(240);

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


  return (
    <div className={`app-container ${isDarkTheme ? "dark" : ""}`}>
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

        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => activateTab(tab.id)}
            className={`tab ${tab.isActive ? "active" : ""}`}
            style={{ width: `${tabWidth}px` }}
          >
            <img src={favicon} alt="" className="tab-favicon" />
            <span className="tab-title">
              {tab.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}
            </span>
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>×</span>
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
          <button className="icon-button" title="Assistant"><img src={logo} alt="" className="assistant-icon" />Assistant</button>
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
              width: "100%", height: "100%",
              display: tab.isActive ? "flex" : "none"
            }}
          />  
        ))}    
      </div>
    </div>
  );
}

export default App;
