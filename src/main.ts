import { app, BrowserWindow } from "electron";
import path from "path";
import { ipcMain } from "electron";
import { decideAction } from "./agent/agent";

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
        attachShortcutHandler(contents);
    });

    win.webContents.on("did-finish-load", () => {
        runAgent();
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


async function takeScreenshot() {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) return null;
    const image = await wc.capturePage();
    const resizeImage = image.resize({ width: 1280 });
    const imageBase64 = resizeImage.toDataURL();
    return imageBase64;
}

async function runAgent(){
    const screenshot = await takeScreenshot();
    const cmd = await decideAction("click something", screenshot);
    console.log("____________________________________________________________________");
    console.log("Sent request to agent, got command:", cmd);

    // Get the focused webContents (could be a webview, not the main window)
    const allContents = require("electron").webContents.getAllWebContents();
    const focusedWc = allContents.find(wc => wc.isFocused()) 
                      ?? BrowserWindow.getAllWindows()[0]?.webContents;

    if (cmd.type === "agent:new-tab") {
        console.log("Agent command is to open a new tab with url:", cmd.url);
        BrowserWindow.getAllWindows()[0]?.webContents.send("agent:new-tab", cmd.url);
    }
    else if (cmd.type === "agent:click") {
        focusedWc.sendInputEvent({
            type: 'mouseDown',
            x: cmd.x,
            y: cmd.y,
            button: 'left',
            clickCount: 1
        });
        focusedWc.sendInputEvent({
            type: 'mouseUp',
            x: cmd.x,
            y: cmd.y,
            button: 'left',
            clickCount: 1
        });
    }
    else if (cmd.type === "agent:type") {
        for (const char of cmd.text) {
            focusedWc.sendInputEvent({ type: 'keyDown', keyCode: char });
            focusedWc.sendInputEvent({ type: 'char',   keyCode: char });
            focusedWc.sendInputEvent({ type: 'keyUp',  keyCode: char });
        }
    }
    /*
    else if (cmd.type === "agent:navigate") {
        BrowserWindow.getAllWindows()[0]?.webContents.send("agent:navigate", cmd.url);
    }
    else if (cmd.type === "agent:scroll") {
        const wc = BrowserWindow.getAllWindows()[0]?.webContents;
        wc.sendInputEvent({
            type: 'mouseWheel',
            x: cmd.x,
            y: cmd.y,
            deltaY: cmd.deltaY
        });
    }
    else {
        BrowserWindow.getAllWindows()[0]?.webContents.send(cmd.type);
    }
    */

}
