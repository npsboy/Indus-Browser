export {};

declare global {
  type BrowserCookie = {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    session?: boolean;
    expirationDate?: number;
    sameSite?: string;
  };

  type SearchEngine = "google" | "duckduckgo" | "brave" | "bing" | "startpage";

  type BrowserSettings = {
    shields: {
      blockTrackers: boolean;
      upgradeHttps: boolean;
      blockThirdPartyCookies: boolean;
      sendGpc: boolean;
      preventWebRtcLeak: boolean;
    };
    shieldsDownSites: string[];
    customBlockList: string[];
    searchEngine: SearchEngine;
    secureDns: { mode: "off" | "automatic" | "secure"; provider: "cloudflare" | "quad9" | "google" | "mullvad" | "custom"; customUrl: string };
    proxy: { mode: "system" | "direct" | "custom"; rules: string; bypass: string };
  };

  type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

  type ShieldsTabState = { site: string; shieldsUp: boolean; blocked: number };

  interface Window {
    api?: {
      ping: () => Promise<unknown>;
      windowConfig: { incognito: boolean; partition: string; initialUrl?: string };
      openIncognitoWindow: (url?: string) => void;
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;
      onPinchZoom: (callback: (direction: "in" | "out", point?: { x: number; y: number }) => void) => (() => void);
      onPinchPan: (callback: (info: { webContentsId: number; dx: number; dy: number }) => void) => (() => void);
      setPinchZoomed: (webContentsId: number, zoomed: boolean) => void;
      onBrowserCommand: (callback: (name: string, arg?: number) => void) => (() => void);
      onWindowMaximized: (callback: (maximized: boolean) => void) => (() => void);
      onWindowBlur: (callback: () => void) => (() => void);
      isWindowMaximized: () => Promise<boolean>;
      onNavCommit: (callback: (info: { webContentsId: number; url: string; inPlace: boolean; replaced: boolean }) => void) => (() => void);
      onAudioState:(callback: (info: { webContentsId: number; audible: boolean }) => void) => (() => void);
      writeClipboardText: (text: string) => void;
      openDevTools: (targetId: number, hostId: number, inspectAt?: { x: number; y: number }) => void;
      closeDevTools: (targetId: number) => void;
      onDevToolsClosed: (callback: (targetId: number) => void) => (() => void);
      getAllCookies: () => Promise<BrowserCookie[]>;
      countCookiesForUrl: (url: string) => Promise<number>;
      removeCookie: (cookie: { domain?: string; path?: string; secure?: boolean; name: string }) => Promise<void>;
      clearSiteData: (site: string) => Promise<void>;
      clearAllSiteData: () => Promise<void>;
      getSettings: () => Promise<BrowserSettings>;
      updateSettings: (patch: DeepPartial<BrowserSettings>) => Promise<BrowserSettings>;
      onSettingsChanged: (callback: (settings: BrowserSettings) => void) => (() => void);
      getShieldsTabState: (webContentsId: number) => Promise<ShieldsTabState | null>;
      setShieldsForSite: (site: string, up: boolean) => Promise<BrowserSettings>;
      onDownloadStarted: (callback: (_event: any, info: { id: string; filename: string }) => void) => (() => void);
      onDownloadProgress: (callback: (_event: any, info: { id: string; percent: number | null }) => void) => (() => void);
      onDownloadDone: (callback: (_event: any, info: { id: string; success: boolean; path: string }) => void) => (() => void);
      showItemInFolder: (filePath: string) => void;
      onAgentNavigate: (callback: (_event: any, url: string) => void) => (() => void);
      onAgentNewTab: (callback: (_event: any, url?: string) => void) => (() => void);
      onAgentReloadActiveTab: (callback: () => void) => (() => void);
      onAgentCloseActiveTab: (callback: () => void) => (() => void);
      onAgentSwitchToTab: (callback: (_event: any, url: string) => void) => (() => void);
      runAgentInstruction: (instruction: string) => Promise<void>;
      onAgentCursorFlash: (callback: (_event: any, pos: { x: number; y: number }) => void) => (() => void);
      onAgentAction: (callback: (_event: any, description: string) => void) => (() => void);
      stopAgent: () => void;
      pauseAgent: () => void;
      resumeAgent: () => void;
      onAgentDone: (callback: (_event: any, answer: string) => void) => (() => void);
      onAgentWarn: (callback: (_event: any, message: string) => void) => (() => void);
      onAgentSupervisor: (callback: (_event: any, info: { count: number; limit: number; task: string; refinedPrompt: string | null }) => void) => (() => void);
      onOpenUrlInNewTab: (callback: (_event: any, url: string, info?: { disposition?: string; openerId?: number }) => void) => (() => void);
      chatRequest: (payload: any) => Promise<any>;
      chatStreamRequest: (payload: any, onChunk: (delta: string) => void) => Promise<any>;
      dispatcherRequest: (text: string) => Promise<any>;
      classifyChatInput: (text: string) => Promise<any>;
    };
  }
}
