import { useState } from "react";
import "./NewTabPage.css";
import logo from "../assets/logos/Logo-Orange.png";

type NewTabPageProps = {
  displayName: string;
  onSearch: (query: string) => void;
};

function NewTabPage({ displayName, onSearch }: NewTabPageProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    onSearch(trimmed);
    setQuery("");
  };

  return (
    <div className="new-tab-page">
      <div className="new-tab-content">
        <div className="new-tab-heading">
          <img src={logo} alt="" className="new-tab-heading-logo" />
          <h1>Welcome back, {displayName}</h1>
        </div>
        <form className="new-tab-search" onSubmit={handleSubmit}>
          <input
            className="new-tab-input"
            type="text"
            placeholder="Search, ask or assign tasks."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="new-tab-submit" type="submit" aria-label="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
              <path d="M12 19V5m-7 7l7-7 7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}

export default NewTabPage;
