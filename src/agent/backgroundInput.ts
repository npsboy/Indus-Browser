/**
 * Input for an agent whose tab isn't the one on screen.
 *
 * Native input (sendInputEvent) only reaches the visible tab — Chromium routes it
 * by hit-testing what's on screen — so a background agent drives its page with
 * events dispatched from JavaScript instead. These are untrusted (isTrusted =
 * false); a few sites ignore them, but most respond normally. Text still goes in
 * through WebContents.insertText, which works without focus or visibility.
 */

const SCRIPT_TIMEOUT_MS = 3000;

async function runInPage<T>(wc: Electron.WebContents, code: string): Promise<T | undefined> {
    if (wc.isDestroyed()) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), SCRIPT_TIMEOUT_MS); });
    try {
        return await Promise.race([wc.mainFrame.executeJavaScript(code) as Promise<T>, timeout]);
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/** The focused element, following focus into shadow roots. */
const DEEP_ACTIVE = `
    const deepActive = () => {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        return el || document.body;
    };
`;

const KEY_INFO: Record<string, { key: string; code: string; keyCode: number }> = {
    enter: { key: "Enter", code: "Enter", keyCode: 13 },
    return: { key: "Enter", code: "Enter", keyCode: 13 },
    tab: { key: "Tab", code: "Tab", keyCode: 9 },
    escape: { key: "Escape", code: "Escape", keyCode: 27 },
    esc: { key: "Escape", code: "Escape", keyCode: 27 },
    backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    delete: { key: "Delete", code: "Delete", keyCode: 46 },
    space: { key: " ", code: "Space", keyCode: 32 },
    " ": { key: " ", code: "Space", keyCode: 32 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
    home: { key: "Home", code: "Home", keyCode: 36 },
    end: { key: "End", code: "End", keyCode: 35 },
};

function describeKey(key: string): { key: string; code: string; keyCode: number } {
    const known = KEY_INFO[key.toLowerCase()];
    if (known) return known;
    if (key.length === 1) {
        const upper = key.toUpperCase();
        const code = /[a-z]/i.test(key) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : "";
        return { key, code, keyCode: upper.charCodeAt(0) };
    }
    return { key, code: key, keyCode: 0 };
}

/**
 * Dispatches keydown / keypress / keyup on the focused element, then performs
 * the default actions untrusted key events don't get: Enter submits the form,
 * Tab moves focus, scroll keys scroll.
 */
export async function pressKeyInBackground(wc: Electron.WebContents, combo: string): Promise<void> {
    const parts = combo.split("+");
    const mods = new Set(parts.slice(0, -1).map(p => p.toLowerCase()));
    const info = describeKey(parts[parts.length - 1]);
    const init = {
        key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode,
        ctrlKey: mods.has("ctrl") || mods.has("control"), shiftKey: mods.has("shift"),
        altKey: mods.has("alt"), metaKey: mods.has("meta") || mods.has("cmd") || mods.has("win"),
    };
    await runInPage(wc, `
        (() => {
            ${DEEP_ACTIVE}
            const target = deepActive();
            const init = Object.assign({ bubbles: true, cancelable: true, composed: true }, ${JSON.stringify(init)});
            const notCancelled = target.dispatchEvent(new KeyboardEvent('keydown', init));
            if (init.key.length === 1 || init.key === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', init));
            target.dispatchEvent(new KeyboardEvent('keyup', init));
            if (!notCancelled || init.ctrlKey || init.metaKey || init.altKey) return;

            const scroller = document.scrollingElement || document.documentElement;
            const page = window.innerHeight * 0.85;
            switch (init.key) {
                case 'Enter': {
                    const form = target.form || (target.closest && target.closest('form'));
                    if (form && target.tagName !== 'TEXTAREA') {
                        if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
                    } else if (target.tagName === 'A' || target.tagName === 'BUTTON' || target.getAttribute('role') === 'button') {
                        target.click();
                    }
                    break;
                }
                case 'Tab': {
                    const focusables = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')]
                        .filter(el => !el.disabled && el.getClientRects().length > 0);
                    const i = focusables.indexOf(target);
                    const next = focusables[(i + (init.shiftKey ? -1 : 1) + focusables.length) % focusables.length];
                    if (next) next.focus();
                    break;
                }
                case ' ': {
                    const editable = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
                    if (!editable) scroller.scrollBy(0, init.shiftKey ? -page : page);
                    break;
                }
                case 'PageDown': scroller.scrollBy(0, page); break;
                case 'PageUp': scroller.scrollBy(0, -page); break;
                case 'Home': if (!target.isContentEditable && !['INPUT', 'TEXTAREA'].includes(target.tagName)) scroller.scrollTo(0, 0); break;
                case 'End': if (!target.isContentEditable && !['INPUT', 'TEXTAREA'].includes(target.tagName)) scroller.scrollTo(0, scroller.scrollHeight); break;
            }
        })()
    `);
}

/**
 * Types text into the focused field: a keydown/keyup pair per character (for
 * sites that listen to keys) around insertText (which fires the `input` events
 * controlled inputs need).
 */
export async function typeInBackground(wc: Electron.WebContents, text: string, beforeEachChar?: () => void): Promise<void> {
    for (const char of text) {
        beforeEachChar?.();
        if (char === "\n" || char === "\r") {
            await pressKeyInBackground(wc, "Enter");
            continue;
        }
        if (char === "\t") {
            await pressKeyInBackground(wc, "Tab");
            continue;
        }
        const info = describeKey(char);
        const init = JSON.stringify({ key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode });
        await runInPage(wc, `
            (() => {
                ${DEEP_ACTIVE}
                const init = Object.assign({ bubbles: true, cancelable: true, composed: true }, ${init});
                deepActive().dispatchEvent(new KeyboardEvent('keydown', init));
                deepActive().dispatchEvent(new KeyboardEvent('keypress', init));
            })()
        `);
        await wc.insertText(char);
        await runInPage(wc, `
            (() => {
                ${DEEP_ACTIVE}
                deepActive().dispatchEvent(new KeyboardEvent('keyup', Object.assign({ bubbles: true, cancelable: true, composed: true }, ${init})));
            })()
        `);
    }
}

/**
 * Scrolls whatever would scroll under (x, y) — the nearest scrollable ancestor
 * of the element there, else the page. (x, y, dx, dy) are in page CSS pixels;
 * positive dy scrolls down.
 */
export async function scrollInBackground(wc: Electron.WebContents, x: number, y: number, dx: number, dy: number): Promise<void> {
    await runInPage(wc, `
        (() => {
            const canScroll = (el) => {
                const style = getComputedStyle(el);
                const scrollsY = ${dy} !== 0 && /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
                const scrollsX = ${dx} !== 0 && /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
                return scrollsY || scrollsX;
            };
            let el = document.elementFromPoint(${x}, ${y});
            while (el && el !== document.body && el !== document.documentElement && !canScroll(el)) {
                el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
            }
            const target = el && el !== document.body && el !== document.documentElement ? el : (document.scrollingElement || document.documentElement);
            target.scrollBy(${dx}, ${dy});
        })()
    `);
}
