import { useState } from "react";
import "./NewTabPage.css";
import logo from "../assets/logos/Logo-Orange.png";
import { useLoadingText } from "../hooks/useLoadingText";

type NewTabPageProps = {
  displayName: string;
  incognito?: boolean;
  onSearch: (query: string) => void | Promise<void>;
  routingError?: string | null;
  onOpenChat?: () => void;
};

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
          <form className="new-tab-search" onSubmit={handleSubmit}>
            <input
              className="new-tab-input"
              type="text"
              placeholder={incognito ? "Search Google or type a URL" : "Search, ask or assign tasks."}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={isRouting}
            />
            <button className="new-tab-submit" type="submit" aria-label="Search" disabled={isRouting}>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
                <path d="M12 19V5m-7 7l7-7 7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </form>
          <div className="new-tab-loading" aria-live="polite">
            {isRouting ? loadingText : routingError || ""}
          </div>
        </div>
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
