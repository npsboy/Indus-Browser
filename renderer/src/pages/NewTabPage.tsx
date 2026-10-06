import { useEffect, useState } from "react";
import "./NewTabPage.css";
import logo from "../assets/logos/Logo-Orange.png";
import { useLoadingText } from "../hooks/useLoadingText";
import { searchEngineName } from "../lib/url";

type NewTabPageProps = {
  displayName: string;
  incognito?: boolean;
  onSearch: (query: string) => void | Promise<void>;
  routingError?: string | null;
  onOpenChat?: () => void;
};

// Incognito only. The toggle and proxy are shared by every incognito window.
function LocationMaskCard() {
  const [mask, setMask] = useState({ enabled: false, proxy: "" });
  const [proxyDraft, setProxyDraft] = useState("");
  const [proxyError, setProxyError] = useState(false);

  useEffect(() => {
    window.api?.getLocationMask().then((m) => {
      setMask(m);
      setProxyDraft(m.proxy);
    });
    return window.api?.onLocationMaskChanged((m) => {
      setMask(m);
      setProxyDraft(m.proxy);
    });
  }, []);

  const saveProxy = async () => {
    const value = proxyDraft.trim();
    if (value === mask.proxy) return;
    const next = await window.api?.setLocationMask({ proxy: value });
    if (!next) return;
    setMask(next);
    // The main process drops values it doesn't accept; show the field as rejected.
    setProxyError(next.proxy !== value);
    if (next.proxy === value) setProxyDraft(next.proxy);
  };

  return (
    <div className="new-tab-location-mask">
      <label
        className="new-tab-location-row"
        title="Blocks location access and masks timezone and language in this incognito session."
      >
        <span className="material-symbols-outlined" aria-hidden="true">location_off</span>
        <span>Hide my location</span>
        <input
          type="checkbox"
          role="switch"
          className="new-tab-switch"
          checked={mask.enabled}
          onChange={(event) => void window.api?.setLocationMask({ enabled: event.target.checked })}
        />
      </label>
      {mask.enabled && (
        <div className="new-tab-location-proxy">
          <input
            type="text"
            className={proxyError ? "invalid" : ""}
            placeholder="Proxy to hide your IP, e.g. socks5://127.0.0.1:9050"
            value={proxyDraft}
            spellCheck={false}
            onChange={(event) => { setProxyDraft(event.target.value); setProxyError(false); }}
            onBlur={() => void saveProxy()}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
          <small>
            {proxyError
              ? "Use http://, https://, socks4:// or socks5:// followed by host:port."
              : mask.proxy
                ? "Your IP address is routed through this proxy. Pages won’t load if it’s unreachable."
                : "No proxy set, so websites can still see your IP address. Add a VPN or SOCKS5 proxy to hide it."}
          </small>
        </div>
      )}
    </div>
  );
}

function NewTabPage({ displayName, incognito, onSearch, routingError, onOpenChat }: NewTabPageProps) {
  const [query, setQuery] = useState("");
  const [isRouting, setIsRouting] = useState(false);
  const loadingText = useLoadingText(isRouting);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || isRouting) return;

    setIsRouting(true);
    try {
      await onSearch(trimmed);
      setQuery("");
    } finally {
      setIsRouting(false);
    }
  };

  return (
    <div className={`new-tab-page${incognito ? " incognito" : ""}`}>
      {onOpenChat && (
        <button
          type="button"
          className="new-tab-open-chat-button"
          title="Open chat"
          aria-label="Open chat"
          onClick={onOpenChat}
        >
          <span className="material-symbols-outlined">chat_bubble</span>
        </button>
      )}
      <div className="new-tab-content">
        {incognito ? (
          <div className="new-tab-heading">
            <span className="material-symbols-outlined new-tab-incognito-icon" aria-hidden="true">domino_mask</span>
            <h1>You’ve gone incognito</h1>
          </div>
        ) : (
          <div className="new-tab-heading">
            <img src={logo} alt="" className="new-tab-heading-logo" />
            <h1>Welcome back, {displayName}</h1>
          </div>
        )}
        <div className="new-tab-search-stack">
          <form className={`new-tab-search${isRouting ? " routing" : ""}`} onSubmit={handleSubmit}>
            <input
              className="new-tab-input"
              type="text"
              placeholder={incognito ? `Search ${searchEngineName()} or type a URL` : "Search, ask or assign tasks."}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
              readOnly={isRouting}
            />
            <button className="new-tab-submit" type="submit" aria-label="Search" disabled={isRouting}>
              {isRouting ? (
                <span className="new-tab-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
                  <path d="M12 19V5m-7 7l7-7 7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
          </form>
          <div className="new-tab-loading" aria-live="polite">
            {isRouting ? (
              <span key="routing" className="new-tab-status new-tab-status-delayed">{loadingText}</span>
            ) : routingError ? (
              <span key="error" className="new-tab-status">{routingError}</span>
            ) : null}
          </div>
        </div>
        {incognito && <LocationMaskCard />}
        {incognito && (
          <div className="new-tab-incognito-info">
            <p>
              Others who use this device won’t see your activity, so you can browse more privately.
              This won’t change how data is collected by the websites you visit or by your network.
            </p>
            <div className="new-tab-incognito-columns">
              <div>
                <h2>Indus won’t save</h2>
                <ul>
                  <li>Your browsing history</li>
                  <li>Cookies and site data</li>
                  <li>Information entered in forms</li>
                </ul>
              </div>
              <div>
                <h2>Your activity might still be visible to</h2>
                <ul>
                  <li>Websites you visit</li>
                  <li>Your employer or school</li>
                  <li>Your internet service provider</li>
                </ul>
              </div>
            </div>
            <p className="new-tab-incognito-note">
              Downloads you save stay on your device. Cookies and site data are deleted when you close all incognito windows.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default NewTabPage;
