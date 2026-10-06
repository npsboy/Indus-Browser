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

// The agent's element labeler (agent/elementLabeler.ts) needs to know which
// elements have click handlers attached from JS, and to see inside closed
// shadow roots — neither is discoverable after the fact. Record both, in the
// page's own world, before any page script runs. Proxies keep behaviour and
// the functions' native toString intact.
try {
  contextBridge.executeInMainWorld({
    func: () => {
      const CLICK_EVENTS = new Set(["click", "dblclick", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"]);
      const listened = new WeakSet<Element>();
      const shadowRoots = new WeakMap<Element, ShadowRoot>();
      EventTarget.prototype.addEventListener = new Proxy(EventTarget.prototype.addEventListener, {
        apply(target, thisArg, args) {
          try {
            if (thisArg instanceof Element && CLICK_EVENTS.has(args[0])) listened.add(thisArg);
          } catch { /* never interfere with the page */ }
          return Reflect.apply(target, thisArg, args);
        },
      });
      Element.prototype.attachShadow = new Proxy(Element.prototype.attachShadow, {
        apply(target, thisArg, args) {
          const root = Reflect.apply(target, thisArg, args);
          try { shadowRoots.set(thisArg, root); } catch { /* ignore */ }
          return root;
        },
      });
      Object.defineProperty(window, "__indusAgentHooks", { value: { listened, shadowRoots }, enumerable: false });
    },
  });
} catch {
  // Labelling falls back to markup heuristics without these.
}

// The preload also runs in subframes (for the hooks above); everything below
// is about the top-level page only.
if (window === window.top) {
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
}
