import {ipcRenderer, contextBridge} from 'electron';


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

function onReloadActiveTab(callback: () => void) {
  ipcRenderer.on("browser:reload-active-tab", callback);
  return () => ipcRenderer.removeListener("browser:reload-active-tab", callback);
}

function onZoomIn(callback: () => void) {
  ipcRenderer.on("browser:zoom-in", callback);
  return () => ipcRenderer.removeListener("browser:zoom-in", callback);
}

function onZoomOut(callback: () => void) {
  ipcRenderer.on("browser:zoom-out", callback);
  return () => ipcRenderer.removeListener("browser:zoom-out", callback);
}

function onPinchZoom(callback: (direction: "in" | "out") => void) {
  const listener = (_event: unknown, direction: "in" | "out") => callback(direction);
  ipcRenderer.on("browser:pinch-zoom", listener);
  return () => ipcRenderer.removeListener("browser:pinch-zoom", listener);
}

function onNewTab(callback: () => void) {
  ipcRenderer.on("browser:new-tab", callback);
  return () => ipcRenderer.removeListener("browser:new-tab", callback);
}

function onCloseActiveTab(callback: () => void) {
  ipcRenderer.on("browser:close-active-tab", callback);
  return () => ipcRenderer.removeListener("browser:close-active-tab", callback);
}

function onReopenClosedTab(callback: () => void) {
  ipcRenderer.on("browser:reopen-closed-tab", callback);
  return () => ipcRenderer.removeListener("browser:reopen-closed-tab", callback);
}

function onFindInPage(callback: () => void) {
  ipcRenderer.on("browser:find-in-page", callback);
  return () => ipcRenderer.removeListener("browser:find-in-page", callback);
}

function onFocusAddressBar(callback: () => void) {
  ipcRenderer.on("browser:focus-address-bar", callback);
  return () => ipcRenderer.removeListener("browser:focus-address-bar", callback);
}

function onOpenHistory(callback: () => void) {
  ipcRenderer.on("browser:open-history", callback);
  return () => ipcRenderer.removeListener("browser:open-history", callback);
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

function onOpenUrlInNewTab(callback: (_event: any, url: string) => void) {
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
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    onReloadActiveTab,
    onZoomIn,
    onZoomOut,
    onPinchZoom,
    onNewTab,
    onCloseActiveTab,
    onReopenClosedTab,
    onFindInPage,
    onFocusAddressBar,
    onOpenHistory,
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
