// Optional "Hide my location" for incognito windows. When on, the incognito
// session (shared by all incognito windows, like its cookies) gets:
//   - the user's own proxy (the only thing that changes the IP sites see),
//   - geolocation requests denied,
//   - WebRTC limited to proxied traffic so it can't reveal the real IP,
//   - UTC timezone, en-US locale and Accept-Language, which otherwise give
//     away the region.
// Held in memory only; it resets when the last incognito window closes.
import { app, type Session, type WebContents } from "electron";

export type LocationMask = { enabled: boolean; proxy: string };

let state: LocationMask = { enabled: false, proxy: "" };
const managed = new Set<Session>();
// webContents ids we attached a debugger to for the timezone/locale override.
const emulated = new Set<number>();

const MASK_LANGUAGE = "en-US,en";
const PROXY_PATTERN = /^(https?|socks4|socks5):\/\/[^\s/]+$/i;

export const getLocationMask = (): LocationMask => ({ ...state });

export function parseLocationMask(input: any): Partial<LocationMask> {
    const patch: Partial<LocationMask> = {};
    if (typeof input?.enabled === "boolean") patch.enabled = input.enabled;
    if (typeof input?.proxy === "string") {
        const proxy = input.proxy.trim();
        if (proxy === "" || PROXY_PATTERN.test(proxy)) patch.proxy = proxy;
    }
    return patch;
}

export function setLocationMask(patch: Partial<LocationMask>) {
    state = { ...state, ...patch };
    for (const ses of managed) applySessionMask(ses);
}

export function resetLocationMask() {
    state = { enabled: false, proxy: "" };
    managed.clear();
}

/** Registers an incognito browsing session; only these are ever masked. */
export function manageSession(ses: Session) {
    if (managed.has(ses)) return;
    managed.add(ses);
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(!(state.enabled && permission === "geolocation")));
    ses.setPermissionCheckHandler((_wc, permission) => !(state.enabled && permission === "geolocation"));
    applySessionMask(ses);
}

/** The proxy rules to force on `ses`, or null to leave it on the normal proxy setting. */
export const proxyOverrideFor = (ses: Session): string | null =>
    state.enabled && state.proxy && managed.has(ses) ? state.proxy : null;

export const webRtcPolicyOverrideFor = (contents: WebContents) =>
    state.enabled && managed.has(contents.session) ? ("disable_non_proxied_udp" as const) : null;

function applySessionMask(ses: Session) {
    ses.setUserAgent(ses.getUserAgent(), state.enabled ? MASK_LANGUAGE : app.getLocale());
}

/** Applies or clears the timezone/locale override on a page. Safe to call any time. */
export async function applyEmulation(contents: WebContents) {
    if (contents.isDestroyed()) return;
    const want = state.enabled && managed.has(contents.session);
    const dbg = contents.debugger;
    try {
        if (want) {
            if (!dbg.isAttached()) dbg.attach("1.3");
            emulated.add(contents.id);
            await dbg.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
            await dbg.sendCommand("Emulation.setLocaleOverride", { locale: "en-US" });
        } else if (emulated.delete(contents.id) && dbg.isAttached()) {
            await dbg.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "" });
            await dbg.sendCommand("Emulation.setLocaleOverride", { locale: "" });
            dbg.detach();
        }
    } catch (error) {
        console.error("[LocationMask] Could not update timezone/locale override.", error);
    }
}
