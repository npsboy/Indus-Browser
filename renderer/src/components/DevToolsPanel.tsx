import { useEffect, useRef, useState } from "react";

export type DevToolsRequest = {
  open: boolean;
  /** Bumped on every open/inspect request so repeat requests re-fire. */
  seq: number;
  inspectAt?: { x: number; y: number };
};

type DevToolsPanelProps = {
  request: DevToolsRequest;
  visible: boolean;
  width: number;
  getTargetId: () => number | null;
  onClose: () => void;
  onResizeStart: (clientX: number) => void;
};

/**
 * Docked DevTools for a single tab. Hosts the DevTools frontend in its own
 * <webview>, which the main process binds to the tab's page via
 * setDevToolsWebContents, so it inspects only that page — never the browser UI.
 * Stays mounted (hidden) once opened so the same host is reused on reopen.
 */
export default function DevToolsPanel({ request, visible, width, getTargetId, onClose, onResizeStart }: DevToolsPanelProps) {
  const hostRef = useRef<(HTMLWebViewElement & { getWebContentsId(): number; getURL(): string; executeJavaScript(code: string): Promise<unknown> }) | null>(null);
  const [hostId, setHostId] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onReady = () => {
      try {
        setHostId(host.getWebContentsId());
      } catch {
        // not attached yet; dom-ready will fire again
      }
    };
    host.addEventListener("dom-ready", onReady, { once: true });
    return () => host.removeEventListener("dom-ready", onReady);
  }, []);

  // Electron leaves the frontend's webContents marked hidden once DevTools
  // loads into it, so nothing paints (rAF never fires, Elements stays blank)
  // until the element is shown again. Bounce its display after every load.
  // Webview methods throw until the guest is attached and dom-ready has fired.
  function hostUrl() {
    try {
      return hostRef.current?.getURL() ?? "";
    } catch {
      return "";
    }
  }

  // capturePage() on the window (the agent does this) can flip it back, so the
  // panel also heals itself on hover.
  function bounceHostDisplay() {
    const host = hostRef.current;
    if (!host) return;
    host.style.display = "none";
    window.requestAnimationFrame(() => {
      host.style.display = "";
    });
  }

  function healIfHidden() {
    const host = hostRef.current;
    if (!host || !hostUrl().startsWith("devtools://")) return;
    host
      .executeJavaScript("document.visibilityState")
      .then((state) => {
        if (state === "hidden") bounceHostDisplay();
      })
      .catch(() => {});
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const timers: number[] = [];
    const onLoad = () => {
      if (!hostUrl().startsWith("devtools://")) return;
      for (const delay of [0, 250]) timers.push(window.setTimeout(bounceHostDisplay, delay));
    };
    host.addEventListener("did-finish-load", onLoad);
    return () => {
      host.removeEventListener("did-finish-load", onLoad);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (visible) healIfHidden();
  }, [visible]);

  useEffect(() => {
    if (!request.open || hostId == null) return;
    const targetId = getTargetId();
    if (targetId == null) return;
    window.api?.openDevTools(targetId, hostId, request.inspectAt);
    // getTargetId is read fresh on purpose; only a new request should re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.open, request.seq, hostId]);

  return (
    <div className="devtools-panel" style={{ width, display: visible ? undefined : "none" }} onMouseEnter={healIfHidden}>
      <div className="devtools-resizer" onMouseDown={(e) => { e.preventDefault(); onResizeStart(e.clientX); }} />
      <div className="devtools-header">
        <span className="devtools-title">
          <span className="material-symbols-outlined" aria-hidden="true">code</span>
          DevTools
        </span>
        <button type="button" className="devtools-close" onClick={onClose} title="Close DevTools (F12)" aria-label="Close DevTools">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      {/* No inline display style here: the agent locates the active page via webview[style*="display: flex"]. */}
      <webview ref={hostRef} src="about:blank" className="devtools-webview" />
    </div>
  );
}
