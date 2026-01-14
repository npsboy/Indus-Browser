import { app, BrowserWindow } from "electron";
import path from "path";
import { ipcMain } from "electron";
import { executeTask } from "./agent/agent";

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

    // Open DevTools by default for debugging
    win.webContents.openDevTools();
  
    app.on("web-contents-created", function (_event, contents) {
        attachShortcutHandler(contents);
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


// Screenshot resize factor (0.5 = 50% of original)
const SCREENSHOT_SCALE_FACTOR = 0.5;

async function takeScreenshot() {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) return null;

    const image = await wc.capturePage();
    
    // Resize to reduce dimensions
    const originalSize = image.getSize();
    const targetWidth = Math.floor(originalSize.width * SCREENSHOT_SCALE_FACTOR);
    const targetHeight = Math.floor(originalSize.height * SCREENSHOT_SCALE_FACTOR);
    
    const resizedImage = image.resize({ 
        width: targetWidth, 
        height: targetHeight,
        quality: 'good'
    });
    
    const jpegBuffer = resizedImage.toJPEG(70);
    const imageBase64 = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;

    return imageBase64;
}

// Function to send task to agent.ts (now in main process)
async function executeAgentTask(userPrompt: string) {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
        console.error('[Main Process] No window found');
        return;
    }
    
    const screenshot = await takeScreenshot();
    // Call agent directly since it's now in the main process
    await executeTask(userPrompt, screenshot, win);
}

// Handle when React UI wants to execute a task
ipcMain.handle('agent:execute-task-from-ui', async (_event, userPrompt: string) => {
    console.log('[Main Process] Received task from UI:', userPrompt);
    await executeAgentTask(userPrompt);
});

// Handle commands from agent.ts
ipcMain.handle('agent-command', async (_event, cmd) => {
    const win = BrowserWindow.getAllWindows()[0];
    
    if (cmd.type === "agent:new-tab") {
        win?.webContents.send("agent:new-tab", cmd.url);
    }
    else if (cmd.type === "agent:navigate") {
        win?.webContents.send("agent:navigate", cmd.url);
    }
    else if (cmd.type === "agent:click") {
        const wc = win?.webContents;
        if (wc) {
            // Scale coordinates back up from resized screenshot
            const actualX = Math.round(cmd.x / SCREENSHOT_SCALE_FACTOR);
            const actualY = Math.round(cmd.y / SCREENSHOT_SCALE_FACTOR);
            
            wc.sendInputEvent({
                type: 'mouseDown',
                x: actualX,
                y: actualY,
                button: 'left',
                clickCount: 1
            });
            wc.sendInputEvent({
                type: 'mouseUp',
                x: actualX,
                y: actualY,
                button: 'left',
                clickCount: 1
            });
        }
    }
    else if (cmd.type === "agent:scroll") {
        const wc = win?.webContents;
        if (wc) {
            // Scale coordinates back up from resized screenshot
            const actualX = Math.round(cmd.x / SCREENSHOT_SCALE_FACTOR);
            const actualY = Math.round(cmd.y / SCREENSHOT_SCALE_FACTOR);
            
            wc.sendInputEvent({
                type: 'mouseWheel',
                x: actualX,
                y: actualY,
                deltaX: 0,
                deltaY: cmd.deltaY
            });
        }
    }
    else if (cmd.type === "agent:screenshot") {
        const screenshot = await takeScreenshot();
        return screenshot;
    }
    else if (cmd.type === "agent:reload-active-tab") {
        win?.webContents.send("agent:reload-active-tab");
    }
    else if (cmd.type === "agent:close-active-tab") {
        win?.webContents.send("agent:close-active-tab");
    }
});