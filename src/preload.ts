import {ipcRenderer, contextBridge} from 'electron';

type WindowConfig = { incognito: boolean; partition: string; initialUrl?: string };

// Fixed for the window's lifetime, and needed before the first render (it picks
// the starting tabs and the <webview> partition), hence the synchronous fetch.
const windowConfig: WindowConfig = ipcRenderer.sendSync('window:get-config');

function openIncognitoWindow(url?: string) {
    ipcRenderer.send('window:new-incognito', url);
}

function ping(){
    return ipcRenderer.invoke('ping');
}

function minimizeWindow() {
    ipcRenderer.send('minimize-window');
}

function maximizeWindow() {
    ipcRenderer.send('maximize-window');
}

function closeWindow() {
    ipcRenderer.send('close-window');
}

function onBrowserCommand(callback: (name: string, arg?: number) => void) {
  const listener = (_event: unknown, name: string, arg?: number) => callback(name, arg);
  ipcRenderer.on("browser:command", listener);
  return () => ipcRenderer.removeListener("browser:command", listener);
}

function onWindowMaximized(callback: (maximized: boolean) => void) {
  const listener = (_event: unknown, maximized: boolean) => callback(maximized);
  ipcRenderer.on("window:maximized", listener);
  return () => ipcRenderer.removeListener("window:maximized", listener);
}

function onWindowBlur(callback: () => void) {
  ipcRenderer.on("window:blur", callback);
  return () => ipcRenderer.removeListener("window:blur", callback);
}

function isWindowMaximized(): Promise<boolean> {
  return ipcRenderer.invoke("window:is-maximized");
}

type NavCommit = { webContentsId: number; url: string; inPlace: boolean; replaced: boolean };

function onNavCommit(callback: (info: NavCommit) => void) {
  const listener = (_event: unknown, info: NavCommit) => callback(info);
  ipcRenderer.on("browser:nav-commit", listener);
  return () => ipcRenderer.removeListener("browser:nav-commit", listener);
}

function onAudioState(callback: (info: { webContentsId: number; audible: boolean }) => void) {
  const listener = (_event: unknown, info: { webContentsId: number; audible: boolean }) => callback(info);
  ipcRenderer.on("browser:audio-state", listener);
  return () => ipcRenderer.removeListener("browser:audio-state", listener);
}

function writeClipboardText(text: string) {
  ipcRenderer.send("clipboard:write-text", text);
}

function openDevTools(targetId: number, hostId: number, inspectAt?: { x: number; y: number }) {
  ipcRenderer.send("devtools:open", targetId, hostId, inspectAt);
}

function closeDevTools(targetId: number) {
  ipcRenderer.send("devtools:close", targetId);
}

function onDevToolsClosed(callback: (targetId: number) => void) {
  const listener = (_event: unknown, targetId: number) => callback(targetId);
  ipcRenderer.on("devtools:closed", listener);
  return () => ipcRenderer.removeListener("devtools:closed", listener);
}

function getAllCookies(): Promise<any[]> {
  return ipcRenderer.invoke("cookies:get-all");
}

function countCookiesForUrl(url: string): Promise<number> {
  return ipcRenderer.invoke("cookies:count-for-url", url);
}

function removeCookie(cookie: { domain?: string; path?: string; secure?: boolean; name: string }): Promise<void> {
  return ipcRenderer.invoke("cookies:remove", cookie);
}

function clearSiteData(site: string): Promise<void> {
  return ipcRenderer.invoke("cookies:clear-site", site);
}

function clearAllSiteData(): Promise<void> {
  return ipcRenderer.invoke("cookies:clear-all");
}

type GuestPoint = { x: number; y: number };

function onPinchZoom(callback: (direction: "in" | "out", point?: GuestPoint) => void) {
  const listener = (_event: unknown, direction: "in" | "out", point?: GuestPoint) => callback(direction, point);
  ipcRenderer.on("browser:pinch-zoom", listener);
  return () => ipcRenderer.removeListener("browser:pinch-zoom", listener);
}

function onPinchPan(callback: (info: { webContentsId: number; dx: number; dy: number }) => void) {
  const listener = (_event: unknown, info: { webContentsId: number; dx: number; dy: number }) => callback(info);
  ipcRenderer.on("browser:pinch-pan", listener);
  return () => ipcRenderer.removeListener("browser:pinch-pan", listener);
}

function setPinchZoomed(webContentsId: number, zoomed: boolean) {
  ipcRenderer.send("browser:set-pinch-zoomed", webContentsId, zoomed);
}

function onDownloadStarted(callback: (_event: any, info: { id: string; filename: string }) => void) {
  ipcRenderer.on("browser:download-started", callback);
  return () => ipcRenderer.removeListener("browser:download-started", callback);
}

function onDownloadProgress(callback: (_event: any, info: { id: string; percent: number | null }) => void) {
  ipcRenderer.on("browser:download-progress", callback);
  return () => ipcRenderer.removeListener("browser:download-progress", callback);
}

function onDownloadDone(callback: (_event: any, info: { id: string; success: boolean; path: string }) => void) {
  ipcRenderer.on("browser:download-done", callback);
  return () => ipcRenderer.removeListener("browser:download-done", callback);
}

function showItemInFolder(filePath: string) {
  ipcRenderer.send("show-item-in-folder", filePath);
}

function onAgentNavigate(callback: (_event: any, url: string) => void) {
  ipcRenderer.on("agent:navigate", callback);
  return () => ipcRenderer.removeListener("agent:navigate", callback);
}

function onAgentNewTab(callback: (_event: any, url?: string) => void) {
  ipcRenderer.on("agent:new-tab", callback);
  return () => ipcRenderer.removeListener("agent:new-tab", callback);
}

function onAgentReloadActiveTab(callback: () => void) {
  ipcRenderer.on("agent:reload-active-tab", callback);
  return () => ipcRenderer.removeListener("agent:reload-active-tab", callback);
}

function onAgentCloseActiveTab(callback: () => void) {
  ipcRenderer.on("agent:close-active-tab", callback);
  return () => ipcRenderer.removeListener("agent:close-active-tab", callback);
}

function onAgentSwitchToTab(callback: (_event: any, url: string) => void) {
  ipcRenderer.on("agent:switch-to-tab", callback);
  return () => ipcRenderer.removeListener("agent:switch-to-tab", callback);
}

function runAgentInstruction(instruction: string): Promise<void> {
  return ipcRenderer.invoke('agent:run-instruction', instruction);
}

function onAgentCursorFlash(callback: (_event: any, pos: { x: number; y: number }) => void) {
  ipcRenderer.on("agent:cursor-flash", callback);
  return () => ipcRenderer.removeListener("agent:cursor-flash", callback);
}

function onAgentAction(callback: (_event: any, description: string) => void) {
  ipcRenderer.on("agent:action", callback);
  return () => ipcRenderer.removeListener("agent:action", callback);
}

function stopAgent() {
  ipcRenderer.send('agent:stop');
}

function pauseAgent() {
  ipcRenderer.send('agent:pause');
}

function resumeAgent() {
  ipcRenderer.send('agent:resume');
}

function onAgentDone(callback: (_event: any, answer: string) => void) {
  ipcRenderer.on('agent:done', callback);
  return () => ipcRenderer.removeListener('agent:done', callback);
}

function onAgentWarn(callback: (_event: any, message: string) => void) {
  ipcRenderer.on('agent:warn', callback);
  return () => ipcRenderer.removeListener('agent:warn', callback);
}

function onAgentSupervisor(callback: (_event: any, info: { count: number; limit: number; task: string; refinedPrompt: string | null }) => void) {
  ipcRenderer.on('agent:supervisor', callback);
  return () => ipcRenderer.removeListener('agent:supervisor', callback);
}

function onOpenUrlInNewTab(callback: (_event: any, url: string, info?: { disposition?: string; openerId?: number }) => void) {
  ipcRenderer.on('browser:open-url-in-new-tab', callback);
  return () => ipcRenderer.removeListener('browser:open-url-in-new-tab', callback);
}

function chatRequest(payload: any): Promise<any> {
    return ipcRenderer.invoke('chat-request', payload);
}

function chatStreamRequest(payload: any, onChunk: (delta: string) => void): Promise<any> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const chunkChannel = `chat-stream-chunk-${requestId}`;
    const doneChannel = `chat-stream-done-${requestId}`;

    return new Promise((resolve) => {
        const onChunkEvent = (_event: any, delta: string) => onChunk(delta);
        const onDoneEvent = (_event: any, result: any) => {
            ipcRenderer.removeListener(chunkChannel, onChunkEvent);
            ipcRenderer.removeListener(doneChannel, onDoneEvent);
            resolve(result);
        };

        ipcRenderer.on(chunkChannel, onChunkEvent);
        ipcRenderer.on(doneChannel, onDoneEvent);
        ipcRenderer.send('chat-request-stream', { requestId, payload });
    });
}

function dispatcherRequest(text: string): Promise<any> {
    return ipcRenderer.invoke('dispatcher-request', text);
}

function classifyChatInput(text: string): Promise<any> {
    return ipcRenderer.invoke('classify-chat-input', text);
}

contextBridge.exposeInMainWorld('api', {
    ping: ping,
    windowConfig,
    openIncognitoWindow,
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    onPinchZoom,
    onPinchPan,
    setPinchZoomed,
    onBrowserCommand,
    onWindowMaximized,
    onWindowBlur,
    isWindowMaximized,
    onAudioState,
    onNavCommit,
    writeClipboardText,
    openDevTools,
    closeDevTools,
    onDevToolsClosed,
    getAllCookies,
    countCookiesForUrl,
    removeCookie,
    clearSiteData,
    clearAllSiteData,
    onDownloadStarted,
    onDownloadProgress,
    onDownloadDone,
    showItemInFolder,
    onAgentNavigate,
    onAgentNewTab,
    onAgentReloadActiveTab,
    onAgentCloseActiveTab,
    onAgentSwitchToTab,
    runAgentInstruction,
    onAgentCursorFlash,
    onAgentAction,
    stopAgent,
    pauseAgent,
    resumeAgent,
    onAgentDone,
    onAgentWarn,
    onAgentSupervisor,
    onOpenUrlInNewTab,
    chatRequest,
    chatStreamRequest,
    dispatcherRequest,
    classifyChatInput
});
