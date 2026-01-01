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
    onAgentReloadActiveTab
});
