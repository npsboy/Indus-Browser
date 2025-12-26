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

contextBridge.exposeInMainWorld('api', {
    ping: ping
});

contextBridge.exposeInMainWorld('electronAPI', {
    minimizeWindow,
    maximizeWindow,
    closeWindow
});
