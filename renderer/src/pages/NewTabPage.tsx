import { useEffect, useState } from "react";
import "./NewTabPage.css";
import logo from "../assets/logos/Logo-Orange.png";

type NewTabPageProps = {
  displayName: string;
  onSearch: (query: string) => void | Promise<void>;
};

function useLoadingText(isLoading: boolean) {
  const [dotCount, setDotCount] = useState(0);

  useEffect(() => {
    if (!isLoading) {
      setDotCount(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setDotCount((current) => (current + 1) % 4);
    }, 400);

    return () => window.clearInterval(intervalId);
  }, [isLoading]);

  return `Loading${dotCount > 0 ? ` ${".".repeat(dotCount)}` : ""}`;
}

function NewTabPage({ displayName, onSearch }: NewTabPageProps) {
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
    <div className="new-tab-page">
      <div className="new-tab-content">
        <div className="new-tab-heading">
          <img src={logo} alt="" className="new-tab-heading-logo" />
          <h1>Welcome back, {displayName}</h1>
        </div>
        <div className="new-tab-search-stack">
          <form className="new-tab-search" onSubmit={handleSubmit}>
            <input
              className="new-tab-input"
              type="text"
              placeholder="Search, ask or assign tasks."
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
            {isRouting ? loadingText : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

export default NewTabPage;
