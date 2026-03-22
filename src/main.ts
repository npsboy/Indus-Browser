import { app, BrowserWindow } from "electron";
import path from "path";
import { ipcMain } from "electron";
import { AgentRunError, type AgentRunResumeState, runAgentWithInstruction, setAgentStopped, setAgentPaused, isAgentStopped } from "./agent/agent";

function attachShortcutHandler(contents) {
  contents.on("before-input-event", function (event, input) {

        if (!input.control && !input.meta) return;

        switch (input.key.toLowerCase()) {
        case "r":
            event.preventDefault();
            BrowserWindow.getAllWindows()[0]?.webContents.send("browser:reload-active-tab");
            break;
        case "t":
            event.preventDefault();
            BrowserWindow.getAllWindows()[0]?.webContents.send("browser:new-tab");
            break;
        case "w":
            event.preventDefault();
            BrowserWindow.getAllWindows()[0]?.webContents.send("browser:close-active-tab");
            break;
        case "=":
            const webContents = BrowserWindow.getAllWindows()[0]?.webContents;
            if (webContents) {
                let zoomLevel = webContents.getZoomLevel();
                webContents.setZoomLevel(zoomLevel + 0.5);
            }
            break;
        case "-":
            const wc = BrowserWindow.getAllWindows()[0]?.webContents;
            if (wc) {
                let zoomLevel = wc.getZoomLevel();
                wc.setZoomLevel(zoomLevel - 0.5);
            }
            break;
        case "q":
            runAgent();
            break;
        default:
            break;
        
    }
  });
}


function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        titleBarStyle: "hidden",

        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true

        }
    });

    attachShortcutHandler(win.webContents);

    win.webContents.setVisualZoomLevelLimits(1, 3);

    win.removeMenu();


    win.loadURL("http://localhost:5173");
  
    app.on("web-contents-created", function (_event, contents) {
        // Skip the main window's webContents — already handled above
        if (contents === win.webContents) return;
        attachShortcutHandler(contents);

        // Intercept new-window requests from webview guests (target="_blank", window.open)
        // and route them to the renderer to open in a new tab instead of a new BrowserWindow
        contents.setWindowOpenHandler((details) => {
            win.webContents.send("browser:open-url-in-new-tab", details.url);
            return { action: "deny" };
        });
    });
    
}


ipcMain.handle('ping', async () => {
    return 'pong';
});

ipcMain.on('minimize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
});

ipcMain.on('maximize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        if (win.isMaximized()) {
            win.unmaximize();
        } else {
            win.maximize();
        }
    }
});

ipcMain.on('close-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
});

app.whenReady().then(createWindow);

ipcMain.handle('agent:run-instruction', async (_event, instruction: string) => {
    await runAgent(instruction);
});

ipcMain.on('agent:stop', () => {
    setAgentStopped(true);
    setAgentPaused(false);
    BrowserWindow.getAllWindows()[0]?.webContents.send('agent:done', '');
});

ipcMain.on('agent:pause', () => {
    setAgentPaused(true);
});

ipcMain.on('agent:resume', () => {
    setAgentPaused(false);
});

let agentRunning = false;

async function runAgent(instruction?: string){
    if (agentRunning) {
        console.log("Agent is already running, ignoring duplicate call.");
        return;
    }

    // New run starts fresh; stop/pause are per-run controls.
    setAgentStopped(false);
    setAgentPaused(false);

    const instructionToRun = instruction ?? "sign me up for github copilot";
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 2500;
    const mainWc = BrowserWindow.getAllWindows()[0]?.webContents;
    let resumeState: AgentRunResumeState | undefined;

    agentRunning = true;
    try {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (isAgentStopped()) {
                console.log("[Agent] Stop requested before attempt; ending run.");
                mainWc?.send('agent:done', '');
                return;
            }
            try {
                const finalAnswer = await runAgentWithInstruction(instructionToRun, resumeState);
                mainWc?.send('agent:done', finalAnswer || '');
                return;
            } catch (error) {
                if (isAgentStopped()) {
                    console.log("[Agent] Stop requested during run; not retrying.");
                    mainWc?.send('agent:done', '');
                    return;
                }
                lastError = error;
                console.error(`[Agent] runAgentWithInstruction failed (attempt ${attempt}/${MAX_ATTEMPTS})`, error);

                if (error instanceof AgentRunError) {
                    resumeState = {
                        plan: error.plan,
                        startTaskIndex: error.resumeTaskIndex,
                    };
                    console.log(`[Agent] Next retry will resume from macro task ${error.resumeTaskIndex + 1}/${error.plan.tasks.length}.`);
                } else {
                    resumeState = undefined;
                }

                if (attempt < MAX_ATTEMPTS) {
                    if (isAgentStopped()) {
                        console.log("[Agent] Stop requested before retry delay; ending run.");
                        mainWc?.send('agent:done', '');
                        return;
                    }
                    const retryLabel = resumeState?.plan
                        ? `macro task ${resumeState.startTaskIndex! + 1}/${resumeState.plan.tasks.length}`
                        : 'same instruction';
                    console.log(`[Agent] Retrying ${retryLabel} in ${RETRY_DELAY_MS}ms...`);
                    await new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                }
            }
        }

        const failureMessage = lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown agent error');
        mainWc?.send('agent:warn', `Agent failed after ${MAX_ATTEMPTS} attempts: ${failureMessage}`);
        mainWc?.send('agent:done', '');
        throw lastError;
    } finally {
        agentRunning = false;
    }
}
