import {ipcRenderer, contextBridge} from 'electron';
import { AgentCommand } from './agent/agent-api';

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
    onAgentReloadActiveTab,
    onAgentCloseActiveTab
});

contextBridge.exposeInMainWorld('agentapi', {
    // For agent.ts to send commands to Main
    sendAgentCommand: (cmd: AgentCommand) => {
        return ipcRenderer.invoke('agent-command', cmd);
    },
    // For Main to send tasks to agent.ts
    onAgentTask: (callback: (task: string, screenshot: string) => void) => {
        const listener = (_event: any, task: string, screenshot: string) => {
            callback(task, screenshot);
        };
        ipcRenderer.on('agent:execute-task', listener);
        return () => ipcRenderer.removeListener('agent:execute-task', listener);
    },
    // For React to send tasks to agent.ts (via Main)
    executeTask: (userPrompt: string) => {
        return ipcRenderer.invoke('agent:execute-task-from-ui', userPrompt);
    }
});