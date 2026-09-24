export {};

declare global {
  interface Window {
    api?: {
      ping: () => Promise<unknown>;
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;
      onReloadActiveTab: (callback: () => void) => (() => void);
      onZoomIn: (callback: () => void) => (() => void);
      onZoomOut: (callback: () => void) => (() => void);
      onPinchZoom: (callback: (direction: "in" | "out") => void) => (() => void);
      onNewTab: (callback: () => void) => (() => void);
      onCloseActiveTab: (callback: () => void) => (() => void);
      onReopenClosedTab: (callback: () => void) => (() => void);
      onFindInPage: (callback: () => void) => (() => void);
      onFocusAddressBar: (callback: () => void) => (() => void);
      onOpenHistory: (callback: () => void) => (() => void);
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
      onOpenUrlInNewTab: (callback: (_event: any, url: string) => void) => (() => void);
      chatRequest: (payload: any) => Promise<any>;
      chatStreamRequest: (payload: any, onChunk: (delta: string) => void) => Promise<any>;
      dispatcherRequest: (text: string) => Promise<any>;
      classifyChatInput: (text: string) => Promise<any>;
    };
  }
}
