import { useMemo, useState } from "react";
import "./HistoryPage.css";

export type HistoryEntry = {
  url: string;
  title: string;
  visitedAt: number;
};

type HistoryPageProps = {
  entries: HistoryEntry[];
  onOpenUrl: (url: string) => void;
  onClear: () => void;
  onClose?: () => void;
};

function formatDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export default function HistoryPage({ entries, onOpenUrl, onClear, onClose }: HistoryPageProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const filtered = trimmed
      ? entries.filter((e) => e.title.toLowerCase().includes(trimmed) || e.url.toLowerCase().includes(trimmed))
      : entries;

    const map = new Map<string, HistoryEntry[]>();
    for (const entry of filtered) {
      const label = formatDayLabel(entry.visitedAt);
      const list = map.get(label) ?? [];
      list.push(entry);
      map.set(label, list);
    }
    return Array.from(map.entries());
  }, [entries, query]);

  return (
    <div className="history-page">
      <div className="history-header">
        <h1>History</h1>
        <div className="history-header-actions">
          <input
            className="history-search-input"
            type="text"
            placeholder="Search history"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="history-clear-btn" onClick={onClear}>
            Clear history
          </button>
          {onClose && (
            <button type="button" className="history-close-btn" onClick={onClose} aria-label="Close history">
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>
      </div>

      <div className="history-list">
        {groups.length === 0 ? (
          <div className="history-empty">No history yet.</div>
        ) : (
          groups.map(([label, items]) => (
            <div key={label} className="history-day-group">
              <div className="history-day-label">{label}</div>
              {items.map((entry, i) => (
                <div
                  key={`${entry.url}-${entry.visitedAt}-${i}`}
                  className="history-item"
                  onClick={() => onOpenUrl(entry.url)}
                >
                  <span className="history-item-title">{entry.title}</span>
                  <span className="history-item-url">{entry.url}</span>
                  <span className="history-item-time">
                    {new Date(entry.visitedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
