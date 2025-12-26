import { useState, useEffect } from "react";
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
    const newTab: Tab = {
      id: crypto.randomUUID(),
      url: newUrl,
      isActive: true
    };
    setTabs([...tabs.map(tab => ({ ...tab, isActive: false })), newTab]);
  }

  function closeTab(targetId: string) {
    let newTabs = tabs.filter(tab => tab.id !== targetId);
    if (newTabs.length > 0) {
      newTabs[newTabs.length - 1].isActive = true;
    }
    setTabs(newTabs);
  }

  const [tabs, setTabs] = useState<Tab[]>([
    { id: "1", url: "https://example.com", isActive: false},
    { id: "2", url: "https://github.com", isActive: true },
  ]);

  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [platform, setPlatform] = useState<'win32' | 'darwin' | 'linux'>('win32');

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

  function toggleTheme() {
    setIsDarkTheme(!isDarkTheme);
  }

  function handleMinimize() {
    if (window.electronAPI?.minimizeWindow) {
      window.electronAPI.minimizeWindow();
    }
  }

  function handleMaximize() {
    if (window.electronAPI?.maximizeWindow) {
      window.electronAPI.maximizeWindow();
    }
  }

  function handleClose() {
    if (window.electronAPI?.closeWindow) {
      window.electronAPI.closeWindow();
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
          <button className="nav-button"><img src={backIcon} alt="Back" /></button>
          <button className="nav-button"><img src={forwardIcon} alt="Forward" /></button>
          <button className="nav-button"><img src={refreshIcon} alt="Refresh" /></button>
        </div>

        {/* Address Bar */}
        <div className="address-bar">
          <img src={favicon} alt="" className="address-favicon" />
          <input 
            type="text" 
            placeholder="Ask anything or navigate..."
            defaultValue={tabs.find(t => t.isActive)?.url || ""} 
            className="address-input" 
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
