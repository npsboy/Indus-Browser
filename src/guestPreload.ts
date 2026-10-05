// Preload for every <webview> guest (attached in main.ts's will-attach-webview).
// Runs in an isolated world, so pages can't see or tamper with it.
import { contextBridge, ipcRenderer } from "electron";

// Global Privacy Control: the Sec-GPC header is added by main (privacy.ts);
// pages that check from script read navigator.globalPrivacyControl instead.
// Defined synchronously so it is in place before any page script runs.
try {
  const flags: { gpc: boolean } = ipcRenderer.sendSync("shields:page-flags", location.href);
  if (flags?.gpc) {
    contextBridge.executeInMainWorld({
      func: () => {
        Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true });
      },
    });
  }
} catch {
  // Never let a privacy nicety break the page.
}

// While the host has this guest pinch-zoomed (a CSS scale on the <webview>),
// two-finger / wheel scrolling pans the zoomed view instead of scrolling the
// page. The host scrolls the page itself once the pan reaches an edge.
let pinchZoomed = false;
ipcRenderer.on("pinch:zoomed", (_event, zoomed: boolean) => {
  pinchZoomed = zoomed;
});

window.addEventListener(
  "wheel",
  (e) => {
    // ctrl+wheel is a pinch (or ctrl+scroll zoom) — leave it to zoom-changed.
    if (!pinchZoomed || e.ctrlKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    // Positive = the direction content should move on screen.
    ipcRenderer.send("pinch:pan", -e.deltaX * unit, -e.deltaY * unit);
  },
  { capture: true, passive: false },
);
