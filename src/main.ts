import { app, BrowserWindow } from "electron";
import path from "path";
import { ipcMain } from "electron";

function attachShortcutHandler(contents) {
  contents.on("before-input-event", function (event, input) {
    if (input.type === "keyDown" && input.control) {
      if (input.key.toLowerCase() === "r") {
        event.preventDefault();
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          "browser:reload-active-tab"
        );
      }
      if (input.key.toLowerCase() === "t") {
        event.preventDefault();
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          "browser:new-tab"
        );
      }
      if (input.key.toLowerCase() === "w") {
        event.preventDefault();
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          "browser:close-active-tab"
        );
      }
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

    win.removeMenu();

    win.loadURL("http://localhost:5173");
  
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


