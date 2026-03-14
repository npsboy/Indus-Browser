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
}

function onNewTab(callback: () => void) {
  ipcRenderer.on("browser:new-tab", callback);
  return () => ipcRenderer.removeListener("browser:new-tab", callback);
}

function onCloseActiveTab(callback: () => void) {
  ipcRenderer.on("browser:close-active-tab", callback);
  return () => ipcRenderer.removeListener("browser:close-active-tab", callback);
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

function onOpenUrlInNewTab(callback: (_event: any, url: string) => void) {
  ipcRenderer.on('browser:open-url-in-new-tab', callback);
  return () => ipcRenderer.removeListener('browser:open-url-in-new-tab', callback);
}

contextBridge.exposeInMainWorld('api', {
    ping: ping,
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    onReloadActiveTab,
    onNewTab,
    onCloseActiveTab,
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
    onOpenUrlInNewTab
});
