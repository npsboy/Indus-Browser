import {ipcRenderer, contextBridge} from 'electron';

console.log("Preload script loaded");

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
    console.log("Setting up reload active tab listener in preload");
  ipcRenderer.on("browser:reload-active-tab", callback);
}



contextBridge.exposeInMainWorld('api', {
    ping: ping,
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    onReloadActiveTab
});
