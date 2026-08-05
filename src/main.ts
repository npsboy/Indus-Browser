import { app, BrowserWindow } from "electron";
import path from "path";
import { ipcMain } from "electron";
import { readFileSync } from "fs";
import { AgentRunError, type AgentRunResumeState, runAgentWithInstruction, setAgentStopped, setAgentPaused, isAgentStopped } from "./agent/agent";

const APP_URL = "http://localhost:5173";

const dispatcherPrompt = readFileSync(path.join(__dirname, "agent/prompts/dispatcher-prompt.md"), "utf-8");
const conversantPrompt = readFileSync(path.join(__dirname, "agent/prompts/conversant-system-prompt.md"), "utf-8");

async function postChat(payload: any) {
    const response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        return { error: true, status: response.status, text: await response.text() };
    }

    const data = await response.json();
    return { error: false, data };
}

function attachShortcutHandler(contents) {
  contents.on("before-input-event", function (event, input) {

        if (!input.control && !input.meta) return;

        switch (input.key.toLowerCase()) {
        case "r":
            event.preventDefault();
            BrowserWindow.getAllWindows()[0]?.webContents.send("browser:reload-active-tab");
            break;
        case "t":
            if (input.isAutoRepeat) return;
            event.preventDefault();
            BrowserWindow.getAllWindows()[0]?.webContents.send("browser:new-tab");
            break;
        case "w":
            if (input.isAutoRepeat) return;
            event.preventDefault();
            BrowserWindow.getAllWindows()[0]?.webContents.send("browser:close-active-tab");
            break;
        case "=":
            event.preventDefault();
            BrowserWindow.getAllWindows()[0]?.webContents.send("browser:zoom-in");
            break;
        case "-":
            event.preventDefault();
            BrowserWindow.getAllWindows()[0]?.webContents.send("browser:zoom-out");
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
        icon: path.join(__dirname, "../renderer/src/assets/logos/Favicon.png"),

        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true,
            // Without this, Chromium throttles timers for occluded/minimized
            // windows, which can starve the Vite HMR websocket's heartbeat and
            // trigger a full page reload once the window regains focus.
            backgroundThrottling: false

        }
    });

    attachShortcutHandler(win.webContents);

    win.webContents.setVisualZoomLevelLimits(1, 3);

    win.removeMenu();


    win.loadURL(APP_URL);

    // The app shell itself must never navigate away from its own UI — a plain
    // <a href> rendered in the renderer (e.g. a link in an agent chat reply)
    // would otherwise navigate win.webContents in place and wipe out the
    // entire toolbar/tab UI. Redirect any such navigation into a new tab.
    win.webContents.on("will-navigate", (event, url) => {
        if (url === APP_URL || url.startsWith(`${APP_URL}/`)) return;
        event.preventDefault();
        win.webContents.send("browser:open-url-in-new-tab", url);
    });

    win.webContents.setWindowOpenHandler((details) => {
        win.webContents.send("browser:open-url-in-new-tab", details.url);
        return { action: "deny" };
    });

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

ipcMain.handle('chat-request', async (_event, payload) => {
    try {
        const requestPayload = payload?.agentRole === "conversant"
            ? {
                ...payload,
                messages: [
                    { role: "system", content: conversantPrompt },
                    ...(Array.isArray(payload.messages) ? payload.messages : [])
                ]
            }
            : payload;

        return await postChat(requestPayload);
    } catch (error: any) {
        return { error: true, status: 0, text: error.message };
    }
});

ipcMain.on('chat-request-stream', async (event, { requestId, payload }) => {
    const chunkChannel = `chat-stream-chunk-${requestId}`;
    const doneChannel = `chat-stream-done-${requestId}`;
    const sender = event.sender;

    try {
        const requestPayload = payload?.agentRole === "conversant"
            ? {
                ...payload,
                messages: [
                    { role: "system", content: conversantPrompt },
                    ...(Array.isArray(payload.messages) ? payload.messages : [])
                ]
            }
            : payload;

        const response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload)
        });

        if (!response.ok) {
            sender.send(doneChannel, { error: true, status: response.status, text: await response.text() });
            return;
        }

        // Fall back to plain JSON if the backend isn't actually streaming
        // (e.g. the streaming Worker branch isn't deployed yet).
        const contentType = response.headers.get("content-type") || "";
        if (!response.body || !contentType.includes("text/event-stream")) {
            sender.send(doneChannel, { error: false, data: await response.json() });
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const dataStr = line.slice(6).trim();
                if (dataStr === "[DONE]") continue;
                try {
                    const parsed = JSON.parse(dataStr);
                    if (typeof parsed.delta === "string") {
                        sender.send(chunkChannel, parsed.delta);
                    }
                } catch {
                    // ignore malformed SSE payloads
                }
            }
        }

        sender.send(doneChannel, { error: false });
    } catch (error: any) {
        sender.send(doneChannel, { error: true, status: 0, text: error.message });
    }
});

ipcMain.handle('dispatcher-request', async (_event, text: string) => {
    try {
        return await postChat({
            agentRole: "dispatcher",
            messages: [
                { role: "system", content: dispatcherPrompt },
                { role: "user", content: text }
            ]
        });
    } catch (error: any) {
        return { error: true, status: 0, text: error.message };
    }
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
