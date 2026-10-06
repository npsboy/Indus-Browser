// User-controlled privacy settings ("Shields"), Brave-style: tracker blocking,
// HTTPS upgrades, third-party cookie blocking, Global Privacy Control, WebRTC
// IP-leak protection, secure DNS, proxy and search engine. Every option is the
// user's choice; the defaults are the private ones.
import { app, webContents } from "electron";
import path from "path";
import { readFileSync, writeFileSync } from "fs";
import { fromElectronDetails } from "@ghostery/adblocker-electron";
import { COSMETIC_PRELOAD, getAdblocker, initAdblock } from "./adblock";
import { proxyOverrideFor, webRtcPolicyOverrideFor } from "./locationMask";

export type SearchEngine = "google" | "duckduckgo" | "brave" | "bing" | "startpage";
export type DnsProvider = "cloudflare" | "quad9" | "google" | "mullvad" | "custom";

export type BrowserSettings = {
    shields: {
        blockTrackers: boolean;
        upgradeHttps: boolean;
        blockThirdPartyCookies: boolean;
        sendGpc: boolean;
        preventWebRtcLeak: boolean;
    };
    // Sites (registrable domains) the user has turned Shields off for.
    shieldsDownSites: string[];
    // Extra domains the user wants blocked, on top of the built-in list.
    customBlockList: string[];
    searchEngine: SearchEngine;
    secureDns: { mode: "off" | "automatic" | "secure"; provider: DnsProvider; customUrl: string };
    proxy: { mode: "system" | "direct" | "custom"; rules: string; bypass: string };
};

const DEFAULT_SETTINGS: BrowserSettings = {
    shields: {
        blockTrackers: true,
        upgradeHttps: true,
        blockThirdPartyCookies: true,
        sendGpc: true,
        preventWebRtcLeak: true,
    },
    shieldsDownSites: [],
    customBlockList: [],
    searchEngine: "google",
    secureDns: { mode: "automatic", provider: "cloudflare", customUrl: "" },
    proxy: { mode: "system", rules: "", bypass: "" },
};

const DNS_SERVERS: Record<Exclude<DnsProvider, "custom">, string> = {
    cloudflare: "https://cloudflare-dns.com/dns-query",
    quad9: "https://dns.quad9.net/dns-query",
    google: "https://dns.google/dns-query",
    mullvad: "https://dns.mullvad.net/dns-query",
};

// Well-known ad, analytics and cross-site tracking hosts. Only used until the
// filter lists (adblock.ts) have loaded, or if they can't be. A request is only
// blocked when it is third-party to the page, so visiting these sites directly
// still works.
const TRACKER_DOMAINS = [
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
    "googletagmanager.com", "googletagservices.com", "adservice.google.com", "connect.facebook.net",
    "scorecardresearch.com", "quantserve.com", "quantcount.com", "adnxs.com", "adsrvr.org",
    "criteo.com", "criteo.net", "taboola.com", "outbrain.com", "amazon-adsystem.com", "hotjar.com",
    "mixpanel.com", "cdn.segment.com", "api.segment.io", "fullstory.com", "mouseflow.com", "clarity.ms",
    "bat.bing.com", "ads-twitter.com", "analytics.twitter.com", "ads.linkedin.com", "snap.licdn.com",
    "analytics.tiktok.com", "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com",
    "indexww.com", "moatads.com", "doubleverify.com", "adsafeprotected.com", "yieldmo.com",
    "sharethrough.com", "smartadserver.com", "teads.tv", "media.net", "zemanta.com", "revcontent.com",
    "mgid.com", "adform.net", "bidswitch.net", "3lift.com", "sovrn.com", "lijit.com", "contextweb.com",
    "gumgum.com", "chartbeat.com", "chartbeat.net", "bluekai.com", "krxd.net", "demdex.net",
    "everesttech.net", "omtrdc.net", "2o7.net", "agkn.com", "rlcdn.com", "tapad.com", "crwdcntrl.net",
    "exelator.com", "mathtag.com", "mc.yandex.ru", "adroll.com", "advertising.com", "yieldlab.net",
];

// ---- Persistence -----------------------------------------------------------

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
let settings: BrowserSettings = structuredClone(DEFAULT_SETTINGS);

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const str = (value: unknown, fallback: string, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : fallback);
const domainList = (value: unknown, fallback: string[]) =>
    Array.isArray(value)
        ? [...new Set(value.filter((d): d is string => typeof d === "string").map(normalizeDomain).filter(Boolean))].slice(0, 5000)
        : fallback;

function normalizeDomain(input: string): string {
    const text = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^\*?\./, "");
    return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(text) ? text : "";
}

/** Merges untrusted input (a settings file, or the renderer) over `base`, keeping only valid values. */
function sanitize(input: any, base: BrowserSettings): BrowserSettings {
    const shields = input?.shields ?? {};
    const dns = input?.secureDns ?? {};
    const proxy = input?.proxy ?? {};
    return {
        shields: {
            blockTrackers: bool(shields.blockTrackers, base.shields.blockTrackers),
            upgradeHttps: bool(shields.upgradeHttps, base.shields.upgradeHttps),
            blockThirdPartyCookies: bool(shields.blockThirdPartyCookies, base.shields.blockThirdPartyCookies),
            sendGpc: bool(shields.sendGpc, base.shields.sendGpc),
            preventWebRtcLeak: bool(shields.preventWebRtcLeak, base.shields.preventWebRtcLeak),
        },
        shieldsDownSites: domainList(input?.shieldsDownSites, base.shieldsDownSites),
        customBlockList: domainList(input?.customBlockList, base.customBlockList),
        searchEngine: pick(input?.searchEngine, ["google", "duckduckgo", "brave", "bing", "startpage"], base.searchEngine),
        secureDns: {
            mode: pick(dns.mode, ["off", "automatic", "secure"], base.secureDns.mode),
            provider: pick(dns.provider, ["cloudflare", "quad9", "google", "mullvad", "custom"], base.secureDns.provider),
            customUrl: str(dns.customUrl, base.secureDns.customUrl),
        },
        proxy: {
            mode: pick(proxy.mode, ["system", "direct", "custom"], base.proxy.mode),
            rules: str(proxy.rules, base.proxy.rules),
            bypass: str(proxy.bypass, base.proxy.bypass),
        },
    };
}

export function loadSettings() {
    try {
        settings = sanitize(JSON.parse(readFileSync(settingsPath(), "utf-8")), DEFAULT_SETTINGS);
    } catch {
        settings = structuredClone(DEFAULT_SETTINGS);
    }
}

export function getSettings(): BrowserSettings {
    return settings;
}

export function updateSettings(patch: unknown): BrowserSettings {
    const p = (patch ?? {}) as any;
    settings = sanitize({
        ...settings,
        ...p,
        shields: { ...settings.shields, ...p.shields },
        secureDns: { ...settings.secureDns, ...p.secureDns },
        proxy: { ...settings.proxy, ...p.proxy },
    }, settings);
    try {
        writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch (error) {
        console.error("[Settings] Could not save settings.", error);
    }
    applyNetworkSettings();
    applyWebRtcPolicy();
    return settings;
}

// ---- Site helpers ----------------------------------------------------------

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return "";
    }
}

/** Rough registrable domain ("www.bbc.co.uk" -> "bbc.co.uk"); matches the renderer's siteOf. */
export function siteOf(host: string): string {
    const clean = host.replace(/^\./, "").toLowerCase();
    if (IPV4_RE.test(clean) || !clean.includes(".")) return clean;
    const labels = clean.split(".");
    if (labels.length <= 2) return clean;
    const secondLevel = labels[labels.length - 2];
    const takeThree = secondLevel.length <= 3 && labels[labels.length - 1].length === 2;
    return labels.slice(takeThree ? -3 : -2).join(".");
}

function matchesDomain(host: string, domain: string) {
    return host === domain || host.endsWith(`.${domain}`);
}

function isLocalHost(host: string) {
    return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || IPV4_RE.test(host) || host.startsWith("[");
}

export function shieldsUpFor(site: string) {
    return !settings.shieldsDownSites.includes(site);
}

export function setShieldsForSite(site: string, up: boolean) {
    const clean = normalizeDomain(site);
    if (!clean) return settings;
    const rest = settings.shieldsDownSites.filter((s) => s !== clean);
    return updateSettings({ shieldsDownSites: up ? rest : [...rest, clean] });
}

// ---- Per-tab state ---------------------------------------------------------

// webContents id -> requests blocked on the current page
const blockedCounts = new Map<number, number>();
// Hosts whose HTTPS upgrade failed; they load over HTTP from then on.
const httpsFallbackHosts = new Set<string>();
// webContents id -> the http:// URL a main-frame upgrade replaced
const pendingUpgrades = new Map<number, { http: string; https: string }>();

export function blockedCountFor(webContentsId: number) {
    return blockedCounts.get(webContentsId) ?? 0;
}

/** The site of the top-level page a request belongs to. */
function topSiteFor(details: Electron.OnBeforeRequestListenerDetails | Electron.OnBeforeSendHeadersListenerDetails | Electron.OnHeadersReceivedListenerDetails) {
    if (details.resourceType === "mainFrame") return siteOf(hostOf(details.url));
    const top = details.frame?.top?.url || details.webContents?.getURL() || details.referrer;
    return siteOf(hostOf(top ?? ""));
}

function isThirdParty(details: Parameters<typeof topSiteFor>[0]) {
    if (details.resourceType === "mainFrame") return false;
    const topSite = topSiteFor(details);
    return Boolean(topSite) && siteOf(hostOf(details.url)) !== topSite;
}

/** Whether "Block trackers & ads" should stop a subresource request, and how. */
function blockVerdict(details: Electron.OnBeforeRequestListenerDetails): Electron.CallbackResponse | null {
    const host = hostOf(details.url);
    const thirdParty = isThirdParty(details);
    if (thirdParty && settings.customBlockList.some((d) => matchesDomain(host, d))) return { cancel: true };

    const blocker = getAdblocker();
    if (!blocker) return thirdParty && TRACKER_DOMAINS.some((d) => matchesDomain(host, d)) ? { cancel: true } : null;

    const request = fromElectronDetails(details);
    if (request.type === "other") request.guessTypeOfRequest();
    const { redirect, match } = blocker.match(request);
    // Some filters swap a script for a harmless stub instead, so pages that expect it keep working.
    if (redirect) return { redirectURL: redirect.dataUrl };
    return match ? { cancel: true } : null;
}

/** Extra Content-Security-Policy the filter lists want on a page or frame (e.g. to stop popunder workers). */
function filterCspFor(details: Electron.OnHeadersReceivedListenerDetails) {
    const blocker = getAdblocker();
    if (!blocker || !settings.shields.blockTrackers) return undefined;
    if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") return undefined;
    return blocker.getCSPDirectives(fromElectronDetails(details));
}

/** Whether element hiding and scriptlets apply to the page `contents` shows (asked by the cosmetic preload). */
function cosmeticFiltersApplyTo(contents: Electron.WebContents) {
    if (contents.getType() !== "webview" || !settings.shields.blockTrackers) return false;
    const url = contents.getURL();
    return /^https?:/.test(url) && shieldsUpFor(siteOf(hostOf(url)));
}

/** Loads the ad/tracker filter lists in the background. Must run after app "ready". */
export function startFilterEngine() {
    initAdblock(cosmeticFiltersApplyTo);
}

// ---- Wiring into sessions --------------------------------------------------

const browsingSessions = new Set<Electron.Session>();

/** Installs Shields on a session pages browse in (the main profile or an incognito one). */
export function setupShields(ses: Electron.Session) {
    if (browsingSessions.has(ses)) return;
    browsingSessions.add(ses);
    applyProxy(ses);
    ses.registerPreloadScript({ type: "frame", filePath: COSMETIC_PRELOAD });

    ses.webRequest.onBeforeRequest((details, callback) => {
        const topSite = topSiteFor(details);
        if (!shieldsUpFor(topSite)) return callback({});
        const host = hostOf(details.url);

        if (
            settings.shields.upgradeHttps &&
            (details.resourceType === "mainFrame" || details.resourceType === "subFrame") &&
            details.url.startsWith("http://") &&
            !isLocalHost(host) &&
            !httpsFallbackHosts.has(host)
        ) {
            const https = "https://" + details.url.slice("http://".length);
            if (details.resourceType === "mainFrame" && details.webContents) {
                pendingUpgrades.set(details.webContents.id, { http: details.url, https });
            }
            return callback({ redirectURL: https });
        }

        const verdict = settings.shields.blockTrackers && details.resourceType !== "mainFrame" ? blockVerdict(details) : null;
        if (verdict) {
            const id = details.webContents?.id;
            if (id !== undefined) blockedCounts.set(id, blockedCountFor(id) + 1);
            return callback(verdict);
        }
        callback({});
    });

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        if (!shieldsUpFor(topSiteFor(details))) return callback({ requestHeaders: details.requestHeaders });
        const headers = { ...details.requestHeaders };
        if (settings.shields.sendGpc) {
            headers["Sec-GPC"] = "1";
            headers["DNT"] = "1";
        }
        if (settings.shields.blockThirdPartyCookies && isThirdParty(details)) {
            for (const name of Object.keys(headers)) {
                if (name.toLowerCase() === "cookie") delete headers[name];
            }
        }
        callback({ requestHeaders: headers });
    });

    ses.webRequest.onHeadersReceived((details, callback) => {
        if (!details.responseHeaders || !shieldsUpFor(topSiteFor(details))) return callback({});
        const stripCookies = settings.shields.blockThirdPartyCookies && isThirdParty(details);
        const csp = filterCspFor(details);
        if (!stripCookies && !csp) return callback({});

        const headers = { ...details.responseHeaders };
        for (const name of Object.keys(headers)) {
            if (stripCookies && name.toLowerCase() === "set-cookie") delete headers[name];
        }
        if (csp) {
            // Sent as one more policy rather than merged into the site's own, so
            // both are enforced and the site's never gets looser.
            const cspName = Object.keys(headers).find((name) => name.toLowerCase() === "content-security-policy") ?? "Content-Security-Policy";
            headers[cspName] = [...(headers[cspName] ?? []), csp];
        }
        callback({ responseHeaders: headers });
    });
}

/** Per-page bookkeeping for a <webview> guest: blocked counts, HTTPS fallback, WebRTC policy. */
export function attachShieldsToGuest(contents: Electron.WebContents) {
    const id = contents.id;
    applyWebRtcPolicyTo(contents);
    contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) blockedCounts.set(id, 0);
    });
    // A site that doesn't serve HTTPS: remember it and load the original http:// URL.
    contents.on("did-fail-load", (_event, errorCode, _description, validatedURL, isMainFrame) => {
        const upgrade = pendingUpgrades.get(id);
        if (!isMainFrame || !upgrade || validatedURL !== upgrade.https || errorCode === -3 /* ABORTED */) return;
        pendingUpgrades.delete(id);
        httpsFallbackHosts.add(hostOf(upgrade.http));
        contents.loadURL(upgrade.http);
    });
    contents.on("did-finish-load", () => pendingUpgrades.delete(id));
    contents.once("destroyed", () => {
        blockedCounts.delete(id);
        pendingUpgrades.delete(id);
    });
}

function applyWebRtcPolicyTo(contents: Electron.WebContents) {
    contents.setWebRTCIPHandlingPolicy(
        webRtcPolicyOverrideFor(contents) ?? (settings.shields.preventWebRtcLeak ? "default_public_interface_only" : "default"),
    );
}

export function applyWebRtcPolicy() {
    for (const contents of webContents.getAllWebContents()) {
        if (contents.getType() === "webview" && !contents.isDestroyed()) applyWebRtcPolicyTo(contents);
    }
}

export function applyProxy(ses: Electron.Session) {
    const { mode, rules, bypass } = settings.proxy;
    const masked = proxyOverrideFor(ses);
    const config: Electron.ProxyConfig =
        masked ? { mode: "fixed_servers", proxyRules: masked, proxyBypassRules: "<local>" }
        : mode === "custom" && rules ? { mode: "fixed_servers", proxyRules: rules, proxyBypassRules: bypass || "<local>" }
        : mode === "direct" ? { mode: "direct" }
        : { mode: "system" };
    ses.setProxy(config).catch((error) => console.error("[Settings] Could not apply proxy.", error));
}

/** Secure DNS and proxy. Must run after app "ready". */
export function applyNetworkSettings() {
    const { mode, provider, customUrl } = settings.secureDns;
    const server = provider === "custom" ? customUrl : DNS_SERVERS[provider];
    const validServer = /^https:\/\/[^\s]+$/.test(server);
    try {
        app.configureHostResolver({
            secureDnsMode: mode === "off" || !validServer ? "off" : mode,
            secureDnsServers: mode !== "off" && validServer ? [server] : [],
        });
    } catch (error) {
        console.error("[Settings] Could not apply secure DNS.", error);
    }
    for (const ses of browsingSessions) {
        applyProxy(ses);
        void ses.clearHostResolverCache();
    }
}

/** Whether a page should see navigator.globalPrivacyControl (read by the guest preload). */
export function gpcEnabledFor(url: string) {
    return settings.shields.sendGpc && shieldsUpFor(siteOf(hostOf(url)));
}

