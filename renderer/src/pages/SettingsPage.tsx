import { useState, type ReactNode } from "react";
import "./CookiesPage.css";
import "./SettingsPage.css";
import { SEARCH_ENGINES } from "../lib/url";

type SettingsPageProps = {
  settings: BrowserSettings | null;
  onClose?: () => void;
};

const SHIELD_OPTIONS: { key: keyof BrowserSettings["shields"]; label: string; detail: string }[] = [
  { key: "blockTrackers", label: "Block trackers & ads", detail: "Blocks ads, trackers and the empty ad slots they leave behind, using the EasyList, EasyPrivacy and uBlock filter lists (updated weekly)." },
  { key: "upgradeHttps", label: "Upgrade connections to HTTPS", detail: "Loads sites over HTTPS when they support it, falling back to HTTP when they don’t." },
  { key: "blockThirdPartyCookies", label: "Block third-party cookies", detail: "Sites you visit can keep their own cookies; embedded third parties can’t follow you across sites." },
  { key: "sendGpc", label: "Send Global Privacy Control", detail: "Tells sites not to sell or share your data (Sec-GPC and Do Not Track)." },
  { key: "preventWebRtcLeak", label: "Prevent WebRTC IP leaks", detail: "Video calls only use your public network interface, so pages can’t read your local IP addresses." },
];

const DNS_PROVIDERS: { value: BrowserSettings["secureDns"]["provider"]; label: string }[] = [
  { value: "cloudflare", label: "Cloudflare (1.1.1.1)" },
  { value: "quad9", label: "Quad9" },
  { value: "google", label: "Google Public DNS" },
  { value: "mullvad", label: "Mullvad" },
  { value: "custom", label: "Custom…" },
];

function save(patch: DeepPartial<BrowserSettings>) {
  void window.api?.updateSettings(patch);
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      {subtitle && <p className="settings-section-subtitle">{subtitle}</p>}
      <div className="cookies-list">{children}</div>
    </section>
  );
}

function Row({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {detail && <div className="settings-row-detail">{detail}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`settings-toggle${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="settings-toggle-knob" />
    </button>
  );
}

/** A text field that saves when it loses focus or Enter is pressed. Callers key it by `value` so it resets when the saved value changes. */
function DraftInput({ value, placeholder, onCommit, wide }: { value: string; placeholder?: string; onCommit: (value: string) => void; wide?: boolean }) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <input
      type="text"
      className={`settings-input${wide ? " wide" : ""}`}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

function DomainList({ domains, onChange, placeholder, empty }: { domains: string[]; onChange: (next: string[]) => void; placeholder: string; empty: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const entries = draft.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
    if (entries.length) onChange([...domains, ...entries]);
    setDraft("");
  };
  return (
    <div className="settings-domains">
      <div className="settings-domains-add">
        <input
          type="text"
          className="settings-input wide"
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button type="button" className="settings-btn" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
      {domains.length === 0 ? (
        <div className="settings-domains-empty">{empty}</div>
      ) : (
        <ul className="settings-domain-list">
          {domains.map((domain) => (
            <li key={domain}>
              <span>{domain}</span>
              <button type="button" className="cookies-icon-btn small" aria-label={`Remove ${domain}`} title="Remove" onClick={() => onChange(domains.filter((d) => d !== domain))}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SettingsPage({ settings, onClose }: SettingsPageProps) {
  return (
    <div className="cookies-page">
      <div className="cookies-inner">
        <div className="cookies-header">
          <div>
            <h1>Settings &amp; Shields</h1>
            <p className="cookies-subtitle">Your browser, your rules. These apply to regular and incognito windows.</p>
          </div>
          <div className="cookies-header-actions">
            {onClose && (
              <button type="button" className="cookies-icon-btn" onClick={onClose} title="Close" aria-label="Close">
                <span className="material-symbols-outlined">close</span>
              </button>
            )}
          </div>
        </div>

        {!settings ? (
          <div className="cookies-empty">Loading…</div>
        ) : (
          <>
            <Section title="Shields" subtitle="Privacy protections on by default. Turn any of them off, or turn Shields off for one site from the address bar.">
              {SHIELD_OPTIONS.map((option) => (
                <Row key={option.key} label={option.label} detail={option.detail}>
                  <Toggle label={option.label} checked={settings.shields[option.key]} onChange={(value) => save({ shields: { [option.key]: value } })} />
                </Row>
              ))}
            </Section>

            <Section title="Sites with Shields off" subtitle="Shields are skipped entirely on these sites, e.g. ones that break with blocking on.">
              <div className="settings-row block">
                <DomainList
                  domains={settings.shieldsDownSites}
                  onChange={(next) => save({ shieldsDownSites: next })}
                  placeholder="example.com"
                  empty="Shields are up everywhere."
                />
              </div>
            </Section>

            <Section title="Custom block list" subtitle="Extra domains to block when they load as a third party, on top of the built-in filter lists.">
              <div className="settings-row block">
                <DomainList
                  domains={settings.customBlockList}
                  onChange={(next) => save({ customBlockList: next })}
                  placeholder="tracker.example.com"
                  empty="No custom entries."
                />
              </div>
            </Section>

            <Section title="Search">
              <Row label="Search engine" detail="Used by the address bar and “Search for…” in menus.">
                <select className="settings-select" value={settings.searchEngine} onChange={(e) => save({ searchEngine: e.target.value as SearchEngine })}>
                  {(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map((engine) => (
                    <option key={engine} value={engine}>{SEARCH_ENGINES[engine].name}</option>
                  ))}
                </select>
              </Row>
            </Section>

            <Section title="Network" subtitle="Choose how this browser resolves and routes your traffic.">
              <Row label="Secure DNS" detail="Encrypts DNS lookups (DNS-over-HTTPS). “Automatic” falls back to your network’s DNS if the provider can’t be reached; “Always” never does.">
                <select className="settings-select" value={settings.secureDns.mode} onChange={(e) => save({ secureDns: { mode: e.target.value as BrowserSettings["secureDns"]["mode"] } })}>
                  <option value="off">Off</option>
                  <option value="automatic">Automatic</option>
                  <option value="secure">Always</option>
                </select>
              </Row>
              {settings.secureDns.mode !== "off" && (
                <Row label="DNS provider">
                  <select className="settings-select" value={settings.secureDns.provider} onChange={(e) => save({ secureDns: { provider: e.target.value as BrowserSettings["secureDns"]["provider"] } })}>
                    {DNS_PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </Row>
              )}
              {settings.secureDns.mode !== "off" && settings.secureDns.provider === "custom" && (
                <Row label="Custom DoH URL" detail="Must start with https://">
                  <DraftInput key={settings.secureDns.customUrl} wide value={settings.secureDns.customUrl} placeholder="https://dns.example/dns-query" onCommit={(customUrl) => save({ secureDns: { customUrl } })} />
                </Row>
              )}
              <Row label="Proxy" detail="Use the system proxy, connect directly, or route through a proxy you choose.">
                <select className="settings-select" value={settings.proxy.mode} onChange={(e) => save({ proxy: { mode: e.target.value as BrowserSettings["proxy"]["mode"] } })}>
                  <option value="system">System settings</option>
                  <option value="direct">No proxy</option>
                  <option value="custom">Custom</option>
                </select>
              </Row>
              {settings.proxy.mode === "custom" && (
                <>
                  <Row label="Proxy server" detail="e.g. socks5://127.0.0.1:9050 or http=proxy:8080;https=proxy:8443">
                    <DraftInput key={settings.proxy.rules} wide value={settings.proxy.rules} placeholder="socks5://host:port" onCommit={(rules) => save({ proxy: { rules } })} />
                  </Row>
                  <Row label="Bypass for" detail="Comma-separated hosts that skip the proxy.">
                    <DraftInput key={settings.proxy.bypass} wide value={settings.proxy.bypass} placeholder="<local>, *.internal.example" onCommit={(bypass) => save({ proxy: { bypass } })} />
                  </Row>
                </>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
