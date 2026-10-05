import type { BrowserWindow } from "electron";

// The regular (non-incognito) browser window. The agent only ever drives this
// one: with incognito windows open, getAllWindows()[0] could be any of them.
let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow | null) {
    mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}
