// The ad/tracker filter engine behind Shields' "Block trackers & ads": Ghostery's
// engine with EasyList, EasyPrivacy and uBlock filters. This file only loads the
// engine and serves its cosmetic filters; privacy.ts decides when it applies.
//
// ElectronBlocker.enableBlockingInSession isn't used: it registers process-wide
// ipcMain handlers per session (a second, incognito session would throw) and
// claims the session's webRequest listeners, which Shields already owns.
import { app, ipcMain } from "electron";
import path from "path";
import { readFile, stat, writeFile } from "fs/promises";
import { ElectronBlocker } from "@ghostery/adblocker-electron";

const ENGINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Frame preload that asks main for cosmetic filters (element hiding, scriptlets).
// Resolved via the electron package, which is what depends on it.
export const COSMETIC_PRELOAD = require.resolve("@ghostery/adblocker-electron-preload", {
    paths: [path.dirname(require.resolve("@ghostery/adblocker-electron"))],
});

let blocker: ElectronBlocker | null = null;

/** The loaded engine, or null while it is still loading (or failed to). */
export function getAdblocker() {
    return blocker;
}

const enginePath = () => path.join(app.getPath("userData"), "adblock-engine.bin");

async function loadEngine(): Promise<ElectronBlocker> {
    const file = enginePath();
    let cached: Buffer | undefined;
    let cacheIsFresh = false;
    try {
        const info = await stat(file);
        cached = await readFile(file);
        cacheIsFresh = Date.now() - info.mtimeMs < ENGINE_MAX_AGE_MS;
    } catch {
        // nothing cached yet
    }

    if (cached && cacheIsFresh) {
        try {
            return ElectronBlocker.deserialize(new Uint8Array(cached));
        } catch {
            // engine format changed with a library update: fetch a new one
        }
    }

    try {
        const engine = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
        await writeFile(file, engine.serialize()).catch((error) => console.error("[Adblock] Could not cache the filter engine.", error));
        return engine;
    } catch (error) {
        // Offline: outdated filters still beat none.
        if (cached) return ElectronBlocker.deserialize(new Uint8Array(cached));
        throw error;
    }
}

/**
 * Loads the engine in the background and answers the cosmetic preload.
 * `appliesTo` says whether blocking is on for the page a frame belongs to.
 */
export function initAdblock(appliesTo: (contents: Electron.WebContents) => boolean) {
    loadEngine()
        .then((engine) => {
            blocker = engine;
            console.log("[Adblock] Filter engine ready.");
        })
        .catch((error) => console.error("[Adblock] Could not load the filter engine; only the built-in tracker list applies.", error));

    ipcMain.handle("@ghostery/adblocker/inject-cosmetic-filters", (event, url: string, msg?: unknown) => {
        if (!blocker || !appliesTo(event.sender)) return;
        return blocker.onInjectCosmeticFilters(event, url, msg as never);
    });
    ipcMain.handle("@ghostery/adblocker/is-mutation-observer-enabled", (event) => {
        if (!blocker || !appliesTo(event.sender)) return false;
        return blocker.onIsMutationObserverEnabled(event);
    });
}
