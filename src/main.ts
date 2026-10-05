import { app, BrowserWindow, clipboard, session, shell, webContents } from "electron";
import path from "path";
import { ipcMain } from "electron";
import { readFileSync } from "fs";
import { AgentRunError, type AgentRunResumeState, runAgentWithInstruction, setAgentStopped, setAgentPaused, isAgentStopped } from "./agent/agent";
import { getMainWindow, setMainWindow } from "./windows";

const APP_URL = "http://localhost:5173";

const dispatcherPrompt = readFileSync(path.join(__dirname, "agent/prompts/dispatcher-prompt.md"), "utf-8");
const conversantPrompt = readFileSync(path.join(__dirname, "agent/prompts/conversant-system-prompt.md"), "utf-8");
const taskClassifierPrompt = readFileSync(path.join(__dirname, "agent/prompts/task-classifier-prompt.md"), "utf-8");

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

const BROWSER_PARTITION = "persist:indus-browser";

// What kind of window a shell (the app UI's webContents) belongs to. The
// renderer reads this once at startup (window:get-config).
type WindowConfig = {
    incognito: boolean;
    // Session partition every <webview> in the window loads pages into.
    partition: string;
    // Page the first tab of a fresh incognito window opens ("Open link in incognito window").
    initialUrl?: string;
};

// shell webContents id -> its window's config
const windowConfigs = new Map<number, WindowConfig>();

// ---- Incognito sessions ----------------------------------------------------
// Like Chrome, all open incognito windows share one in-memory profile: one
// partition for the pages, and a second one for the shell UI itself so its
// localStorage (chats, devtools width) and the favicons it fetches never touch
// the disk either. Partitions without the "persist:" prefix are never written
// to disk. When the last incognito window closes, both are wiped, and the
// generation moves on so the next incognito window starts from new, empty
// sessions.
let incognitoGeneration = 0;
let openIncognitoWindows = 0;
const incognitoWebPartition = () => `indus-incognito-${incognitoGeneration}`;
const incognitoShellPartition = () => `indus-incognito-shell-${incognitoGeneration}`;

async function wipeSession(ses: Electron.Session) {
    await Promise.allSettled([
        ses.clearStorageData(),
        ses.clearCache(),
        ses.clearAuthCache(),
        ses.clearHostResolverCache(),
        ses.closeAllConnections(),
    ]);
}

function endIncognitoSessionIfLast() {
    openIncognitoWindows = Math.max(0, openIncognitoWindows - 1);
    if (openIncognitoWindows > 0) return;
    const sessions = [session.fromPartition(incognitoWebPartition()), session.fromPartition(incognitoShellPartition())];
    incognitoGeneration++;
    sessions.forEach((ses) => void wipeSession(ses));
}

/** The shell (app UI webContents) that owns `contents`: itself, or the host of a <webview>. */
function shellFor(contents: Electron.WebContents): Electron.WebContents | undefined {
    const shell = contents.hostWebContents ?? contents;
    return windowConfigs.has(shell.id) && !shell.isDestroyed() ? shell : undefined;
}

function configFor(contents: Electron.WebContents): WindowConfig | undefined {
    const shell = shellFor(contents);
    return shell ? windowConfigs.get(shell.id) : undefined;
}

/** The session the window that `sender` belongs to browses in. */
function browsingSessionFor(sender: Electron.WebContents): Electron.Session {
    return session.fromPartition(configFor(sender)?.partition ?? BROWSER_PARTITION);
}

function isHttpUrl(url: unknown): url is string {
    if (typeof url !== "string") return false;
    try {
        const { protocol } = new URL(url);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

// webContents ids of <webview>s hosting a docked DevTools frontend. Those get
// a reduced shortcut set (Ctrl+F, Ctrl+R etc. belong to DevTools itself) and
// must not drive page zoom.
const devtoolsHostIds = new Set<number>();
// inspected webContents id -> the DevTools host it has been bound to
const devtoolsHostByTarget = new Map<number, number>();

/** Sends to the app UI of the window that `contents` lives in. */
function sendToShell(contents: Electron.WebContents, channel: string, ...args: unknown[]) {
    shellFor(contents)?.send(channel, ...args);
}

type ShortcutCommand = { name: string; arg?: number; repeatable?: boolean };

function resolveShortcut(input: Electron.Input): ShortcutCommand | null {
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    // AltGr arrives as Ctrl+Alt on Windows; those keystrokes are characters, not shortcuts.
    if (ctrl && input.alt) return null;

    if (!ctrl && !input.alt) {
        switch (key) {
        case "f5": return { name: input.shift ? "hard-reload" : "reload" };
        case "f12": return { name: "devtools" };
        case "f6": return { name: "focus-address" };
        case "f3": return { name: input.shift ? "find-prev" : "find-next", repeatable: true };
        case "escape": return { name: "escape" };
        default: return null;
        }
    }

    if (input.alt && !ctrl) {
        if (key === "arrowleft") return { name: "back", repeatable: true };
        if (key === "arrowright") return { name: "forward", repeatable: true };
        if (key === "d") return { name: "focus-address" };
        return null;
    }

    if (/^[1-9]$/.test(key)) return { name: "select-tab", arg: Number(key) };

    switch (key) {
    case "t": return { name: input.shift ? "reopen-closed-tab" : "new-tab" };
    case "w":
    case "f4": return { name: "close-tab" };
    case "r": return { name: input.shift ? "hard-reload" : "reload" };
    case "f5": return { name: "hard-reload" };
    case "=":
    case "+": return { name: "zoom-in", repeatable: true };
    case "-":
    case "_": return { name: "zoom-out", repeatable: true };
    case "0": return { name: "zoom-reset" };
    case "f": return { name: "find" };
    case "g": return { name: input.shift ? "find-prev" : "find-next", repeatable: true };
    case "l": return { name: "focus-address" };
    case "h": return { name: "history" };
    case "n": return input.shift ? { name: "new-incognito-window" } : null;
    case "tab": return { name: input.shift ? "prev-tab" : "next-tab", repeatable: true };
    case "pagedown": return { name: "next-tab", repeatable: true };
    case "pageup": return { name: "prev-tab", repeatable: true };
    case "i":
    case "j":
    case "c": return input.shift ? { name: "devtools", arg: key === "c" ? 1 : 0 } : null;
    case "delete": return input.shift ? { name: "site-data" } : null;
    default: return null;
    }
}

// Shortcuts still honoured while focus is inside a docked DevTools panel.
const DEVTOOLS_HOST_COMMANDS = new Set(["new-tab", "reopen-closed-tab", "close-tab", "devtools", "next-tab", "prev-tab", "select-tab", "focus-address", "new-incognito-window"]);

function attachShortcutHandler(contents: Electron.WebContents) {
  contents.on("before-input-event", function (event, input) {
        // before-input-event fires for keyDown AND keyUp. Acting on both made
        // every shortcut run twice (Ctrl+T opened two tabs, Ctrl+W closed two).
        if (input.type !== "keyDown") return;

        if ((input.control || input.meta) && !input.shift && !input.alt && input.key.toLowerCase() === "q") {
            // The agent drives the regular window; it has no business in an incognito one.
            if (!input.isAutoRepeat && !configFor(contents)?.incognito) runAgent();
            return;
        }

        const command = resolveShortcut(input);
        if (!command) return;
        if (devtoolsHostIds.has(contents.id) && !DEVTOOLS_HOST_COMMANDS.has(command.name)) return;

        // Escape must still reach the page (dialogs, video players, ...).
        if (command.name !== "escape") event.preventDefault();
        if (input.isAutoRepeat && !command.repeatable) return;

        if (command.name === "new-incognito-window") {
            createWindow({ incognito: true });
            return;
        }
        sendToShell(contents, "browser:command", command.name, command.arg);
  });
}


const downloadSessions = new WeakSet<Electron.Session>();

// Pages download through their window's browsing partition (persist:indus-browser,
// or an incognito one), not the shell's own session.
function setupDownloads(downloadSession: Electron.Session) {
    if (downloadSessions.has(downloadSession)) return;
    downloadSessions.add(downloadSession);
    downloadSession.on("will-download", (_event, item, initiator) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        // Report to the window the download started in, captured now: the tab may close mid-download.
        const shell = initiator ? shellFor(initiator) : undefined;
        const send = (channel: string, info: unknown) => {
            if (shell && !shell.isDestroyed()) shell.send(channel, info);
        };
        send("browser:download-started", { id, filename: item.getFilename() });

        item.on("updated", (_updatedEvent, state) => {
            if (state !== "progressing" || item.isPaused()) return;
            const total = item.getTotalBytes();
            const percent = total > 0 ? Math.round((item.getReceivedBytes() / total) * 100) : null;
            send("browser:download-progress", { id, percent });
        });

        item.once("done", (_doneEvent, state) => {
            send("browser:download-done", {
                id,
                success: state === "completed",
                path: item.getSavePath(),
            });
        });
    });
}

function createWindow(opts: { incognito?: boolean; initialUrl?: string } = {}) {
    const incognito = Boolean(opts.incognito);
    const config: WindowConfig = incognito
        ? { incognito, partition: incognitoWebPartition(), initialUrl: isHttpUrl(opts.initialUrl) ? opts.initialUrl : undefined }
        : { incognito, partition: BROWSER_PARTITION };

    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        titleBarStyle: "hidden",
        icon: path.join(__dirname, "../renderer/src/assets/logos/Favicon.png"),
        backgroundColor: incognito ? "#16131c" : "#111111",

        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true,
            // Without this, Chromium throttles timers for occluded/minimized
            // windows, which can starve the Vite HMR websocket's heartbeat and
            // trigger a full page reload once the window regains focus.
            backgroundThrottling: false,
            // An incognito window's own UI runs in-memory too (see incognitoShellPartition).
            ...(incognito ? { partition: incognitoShellPartition() } : {}),
        }
    });

    // Registered before loadURL: the preload asks for it synchronously.
    const shellId = win.webContents.id;
    windowConfigs.set(shellId, config);
    setupDownloads(session.fromPartition(config.partition));
    if (incognito) {
        openIncognitoWindows++;
    } else {
        setMainWindow(win);
    }
    win.on("closed", () => {
        windowConfigs.delete(shellId);
        if (incognito) endIncognitoSessionIfLast();
        else setMainWindow(null);
    });

    attachShortcutHandler(win.webContents);

    // Native pinch-to-zoom scales the whole compositor surface of the
    // window it's enabled on — for a <webview> guest that means the host
    // chrome (tabs, toolbar) gets visually stretched right along with the
    // page, since the guest is just an embedded layer in the host's
    // compositor. So native visual zoom is left disabled everywhere, and
    // zoom is instead driven by the 'zoom-changed' event below, which fires
    // per-webContents (keyboard, ctrl+wheel, or trackpad pinch) and lets us
    // apply a plain layout zoom (setZoomLevel) to just the webview guest.
    win.webContents.setVisualZoomLevelLimits(1, 1);

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

    // Every <webview> guest gets our own small preload (pinch-zoom panning).
    // Set here rather than as a <webview preload> attribute so pages can't swap it.
    win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
        webPreferences.preload = path.join(__dirname, "guestPreload.js");
        webPreferences.contextIsolation = true;
        webPreferences.nodeIntegration = false;
        // Main decides where an incognito window's pages live, not the <webview>
        // attribute: every guest (pages and DevTools hosts alike) is forced into
        // the in-memory incognito partition.
        if (incognito) {
            webPreferences.partition = config.partition;
            params.partition = config.partition;
        }
    });

    // Last line of defence: a guest that somehow still landed in an on-disk
    // session never gets to load anything in an incognito window.
    win.webContents.on("did-attach-webview", (_event, guest) => {
        if (incognito && guest.session.isPersistent()) {
            console.error("[Incognito] Destroying a <webview> attached to a persistent session.");
            guest.close();
        }
    });

    // The custom title bar swaps its maximize/restore glyph off this.
    const sendMaximized = () => win.webContents.send("window:maximized", win.isMaximized());
    win.on("maximize", sendMaximized);
    win.on("unmaximize", sendMaximized);
    win.on("blur", () => win.webContents.send("window:blur"));
}

// Registered once for the whole app. Guests report to the window hosting them
// (sendToShell), looked up when each event fires.
app.on("web-contents-created", function (_event, contents) {
    // Shells (a window's own UI) are set up in createWindow.
    if (contents.getType() === "window") return;
    attachShortcutHandler(contents);

    // Keep native page-scale zoom off (see the note in createWindow) and instead
    // forward zoom requests (trackpad pinch, ctrl+wheel) to the
    // renderer, which applies a CSS transform: scale() to just this
    // webview's DOM element — a smooth image-like scale, not a layout
    // recalculation, and scoped only to the page content.
    if (contents.getType() === "webview") {
        // The limits are reset on navigation, so re-apply them each time
        // or native pinch can shrink the page below 100%.
        const lockVisualZoom = () => contents.setVisualZoomLevelLimits(1, 1);
        lockVisualZoom();
        contents.on("did-start-navigation", lockVisualZoom);
        contents.on("did-navigate", lockVisualZoom);
        contents.on("did-navigate-in-page", lockVisualZoom);
        contents.on("dom-ready", lockVisualZoom);
        // Tell the renderer whether each main-frame commit replaced the current
        // entry (location.replace, replaceState, client-side redirect) or added
        // one, judged from Chromium's own history; the tab's history list mirrors it.
        let lastNav = { length: -1, index: -1 };
        const reportCommit = (url: string, inPlace: boolean) => {
            const history = contents.navigationHistory;
            const length = history.length();
            const index = history.getActiveIndex();
            const replaced = length === lastNav.length && index === lastNav.index;
            lastNav = { length, index };
            sendToShell(contents, "browser:nav-commit", { webContentsId: contents.id, url, inPlace, replaced });
        };
        contents.on("did-navigate", (_event, url) => reportCommit(url, false));
        contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
            if (isMainFrame) reportCommit(url, true);
        });
        // Last pointer position in the guest's own (untransformed) coordinates,
        // used as the anchor point for pinch-zoom.
        let lastPoint: { x: number; y: number } | undefined;
        contents.on("input-event", (_event, input) => {
            const mouse = input as Electron.MouseInputEvent;
            if (typeof mouse.x === "number" && typeof mouse.y === "number") {
                lastPoint = { x: mouse.x, y: mouse.y };
            }
        });
        // A new page starts with a fresh guest preload; tell it if we're still zoomed.
        contents.on("dom-ready", () => {
            if (pinchZoomedIds.has(contents.id)) contents.send("pinch:zoomed", true);
        });
        contents.once("destroyed", () => pinchZoomedIds.delete(contents.id));
        contents.on("zoom-changed", (_event, zoomDirection) => {
            if (devtoolsHostIds.has(contents.id)) return;
            sendToShell(contents, "browser:pinch-zoom", zoomDirection, lastPoint);
        });
        contents.on("audio-state-changed", (event) => {
            sendToShell(contents, "browser:audio-state", { webContentsId: contents.id, audible: event.audible });
        });
    }

    // Intercept new-window requests from webview guests (target="_blank", window.open)
    // and route them to the renderer to open in a new tab instead of a new BrowserWindow.
    // Ctrl/middle-click arrive as "background-tab" and, like Chrome, must not steal focus.
    contents.setWindowOpenHandler((details) => {
        sendToShell(contents, "browser:open-url-in-new-tab", details.url, {
            disposition: details.disposition,
            openerId: contents.id,
        });
        return { action: "deny" };
    });
});


// Guests currently pinch-zoomed by the renderer (a CSS scale on the <webview>).
// Their guest preload (guestPreload.ts) turns two-finger/wheel scrolling into
// pan deltas while zoomed, which are relayed to the host renderer here.
const pinchZoomedIds = new Set<number>();

ipcMain.on("browser:set-pinch-zoomed", (_event, webContentsId: number, zoomed: boolean) => {
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.getType() !== "webview") return;
    if (zoomed) pinchZoomedIds.add(webContentsId);
    else pinchZoomedIds.delete(webContentsId);
    contents.send("pinch:zoomed", zoomed);
});

ipcMain.on("pinch:pan", (event, dx: number, dy: number) => {
    const guest = event.sender;
    if (guest.getType() !== "webview" || !pinchZoomedIds.has(guest.id)) return;
    guest.hostWebContents?.send("browser:pinch-pan", { webContentsId: guest.id, dx, dy });
});

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

ipcMain.handle('window:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

ipcMain.on('clipboard:write-text', (_event, text: string) => {
    if (typeof text === "string") clipboard.writeText(text);
});

// ---- Docked DevTools -------------------------------------------------------
// The renderer mounts a dedicated <webview> next to the page and hands us both
// webContents ids; DevTools for that one page then renders inside it instead
// of a separate window (Electron's documented setDevToolsWebContents flow).
// A host is bound once per tab and reused on reopen: rebinding to a fresh,
// un-navigated host each time would leave the old pointer dangling.

// A frontend that has just been attached to a fresh host loads with empty
// panels (nothing in Elements/Console/Sources) until DevTools is closed and
// opened once more, so the first open of each host is "primed" with one quiet
// close/reopen cycle once the frontend has loaded.
const primedDevtoolsHosts = new Set<number>();
const quietDevtoolsClose = new Set<number>();

ipcMain.on('devtools:open', (_event, targetId: number, hostId: number, inspectAt?: { x: number; y: number }) => {
    const target = webContents.fromId(targetId);
    const host = webContents.fromId(hostId);
    if (!target || !host || target.isDestroyed() || host.isDestroyed()) return;

    const inspect = () => {
        if (inspectAt && !target.isDestroyed()) target.inspectElement(Math.round(inspectAt.x), Math.round(inspectAt.y));
    };

    // isDevToolsOpened() only reports Electron-managed DevTools windows and is
    // always false for an external host like ours, so it isn't consulted here.
    // openDevTools() is a no-op while the frontend is already attached.
    if (devtoolsHostByTarget.get(targetId) !== hostId) {
        target.closeDevTools();
        devtoolsHostIds.add(hostId);
        devtoolsHostByTarget.set(targetId, hostId);
        target.setDevToolsWebContents(host);
        target.on("devtools-closed", () => {
            if (quietDevtoolsClose.delete(targetId)) return;
            sendToShell(target, "devtools:closed", targetId);
        });
        target.once("destroyed", () => {
            devtoolsHostByTarget.delete(targetId);
            devtoolsHostIds.delete(hostId);
            primedDevtoolsHosts.delete(hostId);
        });
    }

    target.openDevTools();

    if (!primedDevtoolsHosts.has(hostId)) {
        primedDevtoolsHosts.add(hostId);
        const prime = () => {
            if (target.isDestroyed() || host.isDestroyed()) return;
            setTimeout(() => {
                if (target.isDestroyed()) return;
                quietDevtoolsClose.add(targetId);
                target.closeDevTools();
                target.openDevTools();
                // The reopened frontend needs a moment before it accepts a node to select.
                setTimeout(inspect, 700);
                setTimeout(inspect, 1500);
                setTimeout(inspect, 3000);
            }, 300);
        };
        if (host.getURL().startsWith("devtools://") && !host.isLoading()) prime();
        else host.once("did-finish-load", prime);
        return;
    }

    inspect();
});

ipcMain.on('devtools:close', (_event, targetId: number) => {
    const target = webContents.fromId(targetId);
    if (target && !target.isDestroyed()) target.closeDevTools();
});

// ---- Cookies & site data ---------------------------------------------------

function cookieUrl(cookie: { domain?: string; path?: string; secure?: boolean }) {
    const host = (cookie.domain ?? "").replace(/^\./, "");
    return `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
}

function cookieMatchesSite(cookieDomain: string | undefined, site: string) {
    const domain = (cookieDomain ?? "").replace(/^\./, "").toLowerCase();
    const target = site.replace(/^\./, "").toLowerCase();
    return domain === target || domain.endsWith(`.${target}`) || target.endsWith(`.${domain}`);
}

// Each window's cookie UI manages its own window's browsing session, so an
// incognito window only ever sees (and clears) its in-memory cookies.
ipcMain.handle('cookies:get-all', async (event) => {
    return browsingSessionFor(event.sender).cookies.get({});
});

ipcMain.handle('cookies:count-for-url', async (event, url: string) => {
    try {
        const cookies = await browsingSessionFor(event.sender).cookies.get({ url });
        return cookies.length;
    } catch {
        return 0;
    }
});

ipcMain.handle('cookies:remove', async (event, cookie: { domain?: string; path?: string; secure?: boolean; name: string }) => {
    const ses = browsingSessionFor(event.sender);
    await ses.cookies.remove(cookieUrl(cookie), cookie.name);
    await ses.cookies.flushStore();
});

ipcMain.handle('cookies:clear-site', async (event, site: string) => {
    const ses = browsingSessionFor(event.sender);
    const cookies = await ses.cookies.get({});
    await Promise.all(
        cookies
            .filter((c) => cookieMatchesSite(c.domain, site))
            .map((c) => ses.cookies.remove(cookieUrl(c), c.name))
    );
    const host = site.replace(/^\./, "");
    const storages: Electron.ClearStorageDataOptions["storages"] = ["localstorage", "indexdb", "serviceworkers", "cachestorage", "filesystem", "websql"];
    for (const origin of [`https://${host}`, `http://${host}`, `https://www.${host}`]) {
        await ses.clearStorageData({ origin, storages });
    }
    await ses.cookies.flushStore();
});

ipcMain.handle('cookies:clear-all', async (event) => {
    const ses = browsingSessionFor(event.sender);
    await ses.clearStorageData();
    await ses.cookies.flushStore();
});

app.whenReady().then(() => {
    createWindow();
});

// Read synchronously by the preload, before the UI first renders.
ipcMain.on('window:get-config', (event) => {
    const config = windowConfigs.get(event.sender.id);
    event.returnValue = config
        ? { incognito: config.incognito, partition: config.partition, initialUrl: config.initialUrl }
        : { incognito: false, partition: BROWSER_PARTITION };
});

ipcMain.on('window:new-incognito', (_event, url?: string) => {
    createWindow({ incognito: true, initialUrl: url });
});

ipcMain.on('show-item-in-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
});

ipcMain.handle('agent:run-instruction', async (event, instruction: string) => {
    // The agent drives the regular window only; incognito windows can't start it.
    if (configFor(event.sender)?.incognito) return;
    await runAgent(instruction);
});

ipcMain.on('agent:stop', () => {
    setAgentStopped(true);
    setAgentPaused(false);
    getMainWindow()?.webContents.send('agent:done', '');
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

ipcMain.handle('classify-chat-input', async (_event, text: string) => {
    try {
        return await postChat({
            agentRole: "dispatcher",
            messages: [
                { role: "system", content: taskClassifierPrompt },
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
    const mainWc = getMainWindow()?.webContents;
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
