import { BrowserWindow, webContents as allWebContents } from "electron";
import { processScreenshotForAgent } from "./screenshotProcessor";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";


const agentPrompt = readFileSync(join(__dirname, "prompts/agent-prompt.md"), "utf-8");
const plannerPrompt = readFileSync(join(__dirname, "prompts/planner-prompt.md"), "utf-8");

export type AgentTaskPlan = {
    complexity: string;
    tasks: string[];
};

export type AgentRunResumeState = {
    plan?: AgentTaskPlan;
    startTaskIndex?: number;
};

export class AgentRunError extends Error {
    readonly instruction: string;
    readonly plan: AgentTaskPlan;
    readonly resumeTaskIndex: number;

    constructor(message: string, options: {
        instruction: string;
        plan: AgentTaskPlan;
        resumeTaskIndex: number;
        cause?: unknown;
    }) {
        super(message);
        this.name = "AgentRunError";
        this.instruction = options.instruction;
        this.plan = options.plan;
        this.resumeTaskIndex = options.resumeTaskIndex;
        if (options.cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = options.cause;
        }
    }
}

async function planTask(userPrompt: string): Promise<{ complexity: string; tasks?: string[] } | null> {
    const response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            agentRole: "planner",
            messages: [
                { role: "system", content: plannerPrompt },
                { role: "user", content: `This is the user's request. "${userPrompt}"` }
            ]
        })
    });
    const data = await response.json();
    try {
        let replyStr: string;
        if (typeof data.reply === "string") {
            replyStr = data.reply;
        } else {
            replyStr = JSON.stringify(data.reply);
        }
        return JSON.parse(replyStr) as { complexity: string; tasks?: string[] };
    } catch (e) {
        console.error("Failed to parse planner reply:", e);
        return null;
    }
}

async function buildTaskPlan(instruction: string): Promise<AgentTaskPlan> {
    const plannerResult = await planTask(instruction);
    if (!plannerResult) {
        throw new Error("Planner failed to generate a plan.");
    }

    console.log("Planner result:", plannerResult);

    if (plannerResult.complexity === "complex") {
        console.log("Planner determined the task is complex.");
        const tasks = plannerResult.tasks;
        if (!tasks || tasks.length === 0) {
            throw new Error("Planner marked task as complex but did not return any subtasks.");
        }

        return {
            complexity: plannerResult.complexity,
            tasks,
        };
    }

    return {
        complexity: plannerResult.complexity,
        tasks: [instruction],
    };
}


async function GetAction(userPrompt:string, imageurl:string, currentUrl?: string, openTabs?: { id: string; url: string; title?: string; isActive: boolean }[]){
    const tabsContext = openTabs && openTabs.length > 0
        ? `\nOpen tabs:\n${openTabs.map((t, i) => `  ${t.isActive ? '[active] ' : ''}Tab ${i + 1}: ${t.title || 'Untitled'} — ${t.url}`).join('\n')}`
        : "";
    const response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/agent", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
            messages: [
                {
                    role: "system",
                    content: agentPrompt + (past_actions.length > 0
                        ? "\n\nPrevious actions taken so far:\n" + past_actions.map((a, i) => `${i + 1}. ${JSON.stringify(a)}`).join("\n")
                        : "")
                },
                { role: "user", content: `User task: "${userPrompt}"${currentUrl ? `\nCurrent URL: ${currentUrl}` : ""}${tabsContext}` }
            ],
            imageUrl: imageurl
         })
    });
    if (!response.ok) {
        const errText = await response.text();
        console.error(`Agent endpoint error ${response.status}:`, errText);
        return null;
    }
    const data = await response.json();
    return data;
}

/** Reverse of gridLabel(): parse e.g. "a5" → 0-based grid index.
 * Each letter covers 10 raw indices (a→0-9, b→10-19, …).
 * Number 1-10 maps to offset 0-9 within the group. */
function parseLabelIndex(label: string): number {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const match = label.match(/^([a-z])(\d+)$/);
    if (!match) throw new Error(`Invalid grid label: "${label}"`);
    const letterIdx = letters.indexOf(match[1]);  // 0-based letter group
    const num       = parseInt(match[2], 10);     // 1-based number within group
    return letterIdx * 10 + (num - 1);            // 0-based raw grid index
}

/**
 * Convert a column label + row label (e.g. "2c", "3a") into pixel
 * coordinates within the original screenshot (W × H).
 *
 * Grid spacing: colStep = W * 0.015,  rowStep = H * 0.015
 * (mirrors screenshotProcessor.ts)
 */
export function translateCoordinates(
    column_label: string,
    row_label: string,
    screenshotW: number,
    screenshotH: number
): { x: number; y: number } {
    const STEP = 0.015;
    const colIdx = parseLabelIndex(column_label);
    const rowIdx = parseLabelIndex(row_label);
    return {
        x: Math.round(colIdx * screenshotW * STEP),
        y: Math.round(rowIdx * screenshotH * STEP),
    };
}

/** Returns the active webview's guest WebContents and its bounds in window-space. */
async function getActiveWebviewWc(): Promise<{ wc: Electron.WebContents; x: number; y: number; w: number; h: number } | null> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;

    // Ask the renderer for the active webview's bounding rect AND its WebContents ID
    // so we can precisely identify the right WebContents when multiple tabs are open.
    const info: { x: number; y: number; w: number; h: number; wcId: number } | null =
        await win.webContents.executeJavaScript(`
            (() => {
                const wv = document.querySelector('webview[style*="display: flex"]');
                if (!wv) return null;
                const r = wv.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height, wcId: wv.getWebContentsId() };
            })()
        `);

    if (!info) {
        console.error("Could not find active webview bounds");
        return null;
    }

    // Use the exact WebContents ID from the active webview element — avoids picking
    // the wrong tab's WebContents when multiple webviews exist.
    const guestWc = allWebContents.fromId(info.wcId);

    if (!guestWc) {
        console.error("Could not find webview WebContents");
        return null;
    }

    const { wcId: _id, ...bounds } = info;
    return { wc: guestWc, ...bounds };
}

async function takeScreenshot(): Promise<{ base64: string; w: number; h: number; winW: number; winH: number } | null> {
    // Capture only the webview content so all coordinates are webview-relative.
    const MAX_RETRIES = 8;
    const RETRY_DELAY_MS = 750;

    let webviewInfo: { wc: Electron.WebContents; x: number; y: number; w: number; h: number } | null = null;
    let image: Electron.NativeImage | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            await new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) {
            console.warn(`takeScreenshot: no active webview (attempt ${attempt + 1}/${MAX_RETRIES})`);
            continue;
        }
        image = await webviewInfo.wc.capturePage();
        const imageSize = image.getSize();
        if (imageSize.width > 0 && imageSize.height > 0) {
            break; // Got a valid frame
        }
        console.warn(`takeScreenshot: capturePage returned an empty image, retrying... (attempt ${attempt + 1}/${MAX_RETRIES})`);
        image = null;
    }

    if (!webviewInfo || !image) {
        console.error("takeScreenshot: could not capture a valid screenshot after retries");
        return null;
    }

    const winW = Math.round(webviewInfo.w);
    const winH = Math.round(webviewInfo.h);
    const resized = image.resize({ width: 1200 });
    const w = resized.getSize().width;
    const h = resized.getSize().height;
    const rawBase64 = resized.toDataURL();
    if (!rawBase64 || rawBase64 === "data:,") {
        console.error("takeScreenshot: toDataURL returned empty string");
        return null;
    }
    // Scale last click position from webview CSS pixels to resized-screenshot pixels.
    const cursorInShot = lastCursorPos
        ? { x: Math.round(lastCursorPos.x * (w / winW)), y: Math.round(lastCursorPos.y * (h / winH)) }
        : undefined;
    const processedBase64 = await processScreenshotForAgent(rawBase64, cursorInShot);

    // Save to disk for inspection
    const savePath = join(tmpdir(), "indus-agent-screenshot.jpg");
    const imgData = processedBase64.replace(/^data:image\/\w+;base64,/, "");
    writeFileSync(savePath, Buffer.from(imgData, "base64"));

    return { base64: processedBase64, w, h, winW, winH };
}

/**
 * Finds the most likely clickable target near (targetX, targetY) in the webview.
 *
 * The search prefers elements that are actually topmost under the pointer (via
 * `elementsFromPoint`) instead of only matching a static selector list. This makes
 * tiny controls such as popup close buttons more reliable, even when the clickable
 * semantics live on an ancestor or are expressed through cursor/ARIA heuristics.
 * Returns a point inside the resolved clickable target, or the original coords if
 * no better target is found within MAX_RADIUS CSS pixels.
 */
async function snapToNearestClickablePoint(
    wc: Electron.WebContents,
    targetX: number,
    targetY: number,
    maxRadius = 180
): Promise<{ x: number; y: number }> {
    const result = await wc.executeJavaScript(`
        (() => {
            const targetX = ${targetX};
            const targetY = ${targetY};
            const maxRadius = ${maxRadius};

            const CLICKABLE_TAGS = new Set([
                'a', 'button', 'input', 'select', 'textarea', 'summary',
                'label', 'option', 'details'
            ]);
            const INTERACTIVE_ROLES = new Set([
                'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
                'tab', 'checkbox', 'radio', 'option', 'switch'
            ]);
            const CLOSE_KEYWORDS = /(^|[^a-z])(close|dismiss|cancel|remove|delete|clear|exit|x)([^a-z]|$)/i;

            const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
            const roundPoint = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
            const inViewport = (x, y) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;

            const getParentElement = (el) => {
                if (!el || !(el instanceof Element)) return null;
                if (el.parentElement) return el.parentElement;
                const root = el.getRootNode?.();
                if (root instanceof ShadowRoot && root.host instanceof Element) return root.host;
                return null;
            };

            const isVisible = (el) => {
                if (!el || !(el instanceof Element)) return false;
                let current = el;
                while (current) {
                    const style = window.getComputedStyle(current);
                    if (
                        style.display === 'none' ||
                        style.visibility === 'hidden' ||
                        style.pointerEvents === 'none' ||
                        style.opacity === '0'
                    ) {
                        return false;
                    }
                    current = getParentElement(current);
                }
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                return rect.bottom > 0 && rect.right > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
            };

            const isDisabled = (el) => {
                if (!(el instanceof Element)) return false;
                return el.matches(':disabled,[aria-disabled="true"]');
            };

            const hasCloseLikeSemantics = (el) => {
                if (!(el instanceof Element)) return false;
                const text = [
                    el.getAttribute('aria-label'),
                    el.getAttribute('title'),
                    el.getAttribute('name'),
                    el.getAttribute('alt'),
                    el.getAttribute('data-testid'),
                    el.getAttribute('data-test'),
                    el.id,
                    typeof el.className === 'string' ? el.className : '',
                ].filter(Boolean).join(' ');
                return CLOSE_KEYWORDS.test(text);
            };

            const isClickableCandidate = (el) => {
                if (!el || !(el instanceof Element) || !isVisible(el) || isDisabled(el)) return false;

                const tag = el.tagName.toLowerCase();
                const role = (el.getAttribute('role') || '').toLowerCase();
                const type = (el.getAttribute('type') || '').toLowerCase();
                const tabIndex = el.getAttribute('tabindex');
                const style = window.getComputedStyle(el);

                if (tag === 'input' && type === 'hidden') return false;
                if (CLICKABLE_TAGS.has(tag)) return true;
                if (INTERACTIVE_ROLES.has(role)) return true;
                if (el.hasAttribute('href') || (tag === 'a' && !!el.getAttribute('href'))) return true;
                if (el.hasAttribute('onclick') || typeof el.onclick === 'function') return true;
                if (tabIndex !== null && tabIndex !== '-1') return true;
                if (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true') return true;
                if (style.cursor === 'pointer') return true;
                if (hasCloseLikeSemantics(el)) return true;

                return false;
            };

            const resolveClickableTarget = (startEl) => {
                let current = startEl;
                let hops = 0;
                while (current && hops < 8) {
                    if (isClickableCandidate(current)) return { el: current, hops };
                    current = getParentElement(current);
                    hops += 1;
                }
                return null;
            };

            const pointInsideRect = (rect, preferredX, preferredY) => {
                const minX = rect.width <= 2 ? (rect.left + rect.right) / 2 : rect.left + 1;
                const maxX = rect.width <= 2 ? (rect.left + rect.right) / 2 : rect.right - 1;
                const minY = rect.height <= 2 ? (rect.top + rect.bottom) / 2 : rect.top + 1;
                const maxY = rect.height <= 2 ? (rect.top + rect.bottom) / 2 : rect.bottom - 1;
                return roundPoint(clamp(preferredX, minX, maxX), clamp(preferredY, minY, maxY));
            };

            let best = null;
            let bestScore = Infinity;

            const considerPoint = (sampleX, sampleY, scanRadius) => {
                if (!inViewport(sampleX, sampleY)) return;

                const stack = document.elementsFromPoint(sampleX, sampleY);
                const seen = new Set();

                for (let stackIndex = 0; stackIndex < stack.length; stackIndex += 1) {
                    const resolved = resolveClickableTarget(stack[stackIndex]);
                    if (!resolved) continue;

                    const { el, hops } = resolved;
                    if (seen.has(el)) continue;
                    seen.add(el);

                    const rect = el.getBoundingClientRect();
                    const clickPoint = pointInsideRect(rect, sampleX, sampleY);
                    const distToTarget = Math.hypot(clickPoint.x - targetX, clickPoint.y - targetY);
                    if (distToTarget > maxRadius) continue;

                    const area = Math.max(1, rect.width * rect.height);
                    const score =
                        distToTarget * 100 +
                        scanRadius * 10 +
                        stackIndex * 6 +
                        hops * 3 +
                        Math.min(12, Math.log(area + 1));

                    if (score >= bestScore) continue;
                    bestScore = score;
                    best = clickPoint;

                    if (distToTarget === 0 && stackIndex === 0 && hops === 0) {
                        return true;
                    }
                }

                return false;
            };

            if (considerPoint(Math.round(targetX), Math.round(targetY), 0)) {
                return best;
            }

            for (let radius = 6; radius <= maxRadius; radius += 6) {
                const steps = Math.max(8, Math.ceil((Math.PI * 2 * radius) / 10));
                for (let step = 0; step < steps; step += 1) {
                    const angle = (step / steps) * Math.PI * 2;
                    const sampleX = Math.round(targetX + Math.cos(angle) * radius);
                    const sampleY = Math.round(targetY + Math.sin(angle) * radius);
                    if (considerPoint(sampleX, sampleY, radius)) {
                        return best;
                    }
                }
            }

            return best || roundPoint(targetX, targetY);
        })()
    `).catch(() => null);

    if (result && typeof result.x === "number" && typeof result.y === "number") {
        return { x: result.x, y: result.y };
    }
    return { x: targetX, y: targetY };
}

async function executeCommand(cmd: any): Promise<void> {
    const mainWc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!mainWc) return;

    if (cmd.type === "agent:new-tab") {
        mainWc.send("agent:new-tab", cmd.url);
    } else if (cmd.type === "agent:click") {
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) {
            console.error("Cannot click: no active webview found");
            return;
        }
        const snappedPoint = await snapToNearestClickablePoint(webviewInfo.wc, cmd.x, cmd.y);
        const relX = snappedPoint.x;
        const relY = snappedPoint.y;
        lastCursorPos = { x: relX, y: relY };

        BrowserWindow.getAllWindows()[0]?.focus();
        webviewInfo.wc.focus();

        // Native input events — these are trusted (isTrusted=true) and work on
        // all sites including those that reject synthetic JS events.
        webviewInfo.wc.sendInputEvent({ type: 'mouseMove', x: relX, y: relY });
        webviewInfo.wc.sendInputEvent({ type: 'mouseDown', x: relX, y: relY, button: 'left', clickCount: 1 });
        await new Promise<void>(r => setTimeout(r, 80));
        webviewInfo.wc.sendInputEvent({ type: 'mouseUp', x: relX, y: relY, button: 'left', clickCount: 1 });

        // JS fallback: walk up to the nearest <a>/<button>/interactive ancestor and
        // call .click() on it. This covers React/SPA event-delegation cases where the
        // handler lives on a container rather than the leaf element. We do NOT send
        // extra pointer/mouse events here — duplicating them can cause double-actions.
        await webviewInfo.wc.executeJavaScript(`
            (function() {
                const CLICKABLE_TAGS = new Set(['a','button','input','select','textarea','label']);
                let el = document.elementFromPoint(${relX}, ${relY});
                while (el && el !== document.documentElement && el !== document.body) {
                    const tag = el.tagName.toLowerCase();
                    const role = (el.getAttribute('role') || '').toLowerCase();
                    if (CLICKABLE_TAGS.has(tag) || el.hasAttribute('onclick') ||
                        role === 'button' || role === 'link' || role === 'menuitem' ||
                        role === 'tab' || role === 'option' || role === 'checkbox') {
                        el.click();
                        return;
                    }
                    el = el.parentElement;
                }
                // Nothing semantic found — click whatever is directly at the point.
                const leaf = document.elementFromPoint(${relX}, ${relY});
                if (leaf) leaf.click();
            })()
        `).catch(() => {});

        mainWc.send("agent:cursor-flash", { x: Math.round(webviewInfo.x + relX), y: Math.round(webviewInfo.y + relY) });
    } else if (cmd.type === "agent:type") {
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) return;
        // Ensure the webview has focus so keystrokes aren't silently dropped.
        BrowserWindow.getAllWindows()[0]?.focus();
        webviewInfo.wc.focus();

        // Send each character as a full keyDown → insertText → keyUp sequence.
        // - keyDown/keyUp fire the keyboard events that game/canvas sites (e.g. Wordle)
        //   listen to on document/window — insertText() alone is invisible to them.
        // - insertText() fires the native `input` event that React-controlled inputs
        //   require to update their state.
        // Together this covers both cases without double-typing.
        const KEY_CODE_MAP: Record<string, string> = {
            '\n': 'Return', '\r': 'Return', '\t': 'Tab', ' ': 'Space',
            '\b': 'Backspace',
        };
        const shouldInsertText = (char: string) => !['\n', '\r', '\t', '\b'].includes(char);
        for (const char of cmd.text) {
            const keyCode = KEY_CODE_MAP[char] ?? char;
            webviewInfo.wc.sendInputEvent({ type: 'keyDown', keyCode } as any);
            if (shouldInsertText(char)) {
                // insertText for printable characters (including space) so controlled
                // inputs and contenteditable targets receive text updates.
                await webviewInfo.wc.insertText(char);
            }
            webviewInfo.wc.sendInputEvent({ type: 'keyUp', keyCode } as any);
            // Small inter-character delay so rapid keydown events aren't dropped.
            await new Promise<void>(r => setTimeout(r, 30));
        }
    } else if (cmd.type === "agent:navigate") {
        if (cmd.new_tab !== false) {
            // If the URL is already open in a tab, switch to it instead of opening a new one.
            const mainWin = BrowserWindow.getAllWindows()[0];
            const openTabs: { id: string; url: string; isActive: boolean }[] = mainWin
                ? await mainWin.webContents.executeJavaScript('window.__tabs || []').catch(() => [])
                : [];
            const normalize = (u: string) => u.replace(/\/$/, "");
            const existingTab = openTabs.find(t => normalize(t.url) === normalize(cmd.url));
            if (existingTab) {
                mainWc.send("agent:switch-to-tab", cmd.url);
            } else {
                mainWc.send("agent:new-tab", cmd.url);
            }
        } else {
            mainWc.send("agent:navigate", cmd.url);
        }
    } else if (cmd.type === "agent:scroll") {
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) return;
        // Focus both the OS window and the webContents so scroll events are routed correctly.
        BrowserWindow.getAllWindows()[0]?.focus();
        webviewInfo.wc.focus();
        // Move mouse to the scroll target first so the renderer picks the right element.
        webviewInfo.wc.sendInputEvent({ type: 'mouseMove', x: cmd.x, y: cmd.y, movementX: 0, movementY: 0 } as any);
        // cmd.x/y are already webview-relative — no offset subtraction needed.
        webviewInfo.wc.sendInputEvent({ type: 'mouseWheel', x: cmd.x, y: cmd.y, deltaX: cmd.deltaX ?? 0, deltaY: cmd.deltaY ?? 0, canScroll: true } as any);
    } else if (cmd.type === "agent:keypress") {
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) return;
        // Ensure the webview has focus so key events aren't silently dropped.
        BrowserWindow.getAllWindows()[0]?.focus();
        webviewInfo.wc.focus();

        // Parse modifier+key combinations like "ctrl+a", "ctrl+shift+t", etc.
        const MODIFIER_MAP: Record<string, string> = {
            ctrl: 'control', control: 'control',
            shift: 'shift',
            alt: 'alt',
            meta: 'meta', cmd: 'meta', win: 'meta',
        };
        const parts = cmd.key.toLowerCase().split('+');
        const modifiers: string[] = [];
        let keyCode = cmd.key; // fallback to raw value
        if (parts.length > 1) {
            const keyPart = parts[parts.length - 1];
            const modParts = parts.slice(0, -1);
            modParts.forEach(p => {
                if (MODIFIER_MAP[p]) modifiers.push(MODIFIER_MAP[p]);
            });
            // Preserve original casing of the key character
            const originalParts = cmd.key.split('+');
            keyCode = originalParts[originalParts.length - 1];
        }

        const eventBase = modifiers.length > 0 ? { modifiers } : {};

        // Map well-known key names to their char equivalents so the `char` event
        // (which fires the DOM `keypress` event) contains the right character.
        // This is what React/framework handlers on sites like Amazon listen for.
        const KEY_TO_CHAR: Record<string, string> = {
            Return: '\r', Enter: '\r',
            Tab: '\t',
            Space: ' ', ' ': ' ',
            Backspace: '\b',
            Escape: '\x1b',
        };
        const charValue = KEY_TO_CHAR[keyCode] ?? (keyCode.length === 1 ? keyCode : null);

        webviewInfo.wc.sendInputEvent({ type: 'keyDown', keyCode, ...eventBase } as any);
        // The `char` event is what actually fires the DOM `keypress` event.
        // Without it, React/jQuery handlers on many sites (e.g. Amazon search submit)
        // never receive the keystroke.
        if (charValue) {
            webviewInfo.wc.sendInputEvent({ type: 'char', keyCode: charValue, ...eventBase } as any);
        }
        webviewInfo.wc.sendInputEvent({ type: 'keyUp',   keyCode, ...eventBase } as any);
        console.log(`[Agent] Key pressed: ${cmd.key}${modifiers.length ? ` (modifiers: ${modifiers.join('+')})` : ''}`);
    } else if (cmd.type === "agent:wait") {
        console.log(`[Agent] Waiting ${cmd.seconds}s...`);
        await new Promise<void>(resolve => setTimeout(resolve, cmd.seconds * 1000));
    }
}

function getCommand(tool, winW, winH, ssW, ssH): any {
if (!tool) return;

    let tool_arguments: any = {};
    if (tool?.arguments) {
        tool_arguments = typeof tool.arguments === "string"
            ? JSON.parse(tool.arguments)
            : tool.arguments;
    }

    let cmd: any;
    if (tool.name === "click") {
        // translateCoordinates maps grid labels → resized-screenshot space.
        // Scale to webview CSS pixels (winW/winH = webview dimensions).
        const ssCoords = translateCoordinates(tool_arguments.x, tool_arguments.y, ssW, ssH);
        const clickX = Math.round(ssCoords.x * (winW / ssW));
        const clickY = Math.round(ssCoords.y * (winH / ssH));
        cmd = { type: "agent:click", x: clickX, y: clickY };
    } else if (tool.name === "type") {
        cmd = { type: "agent:type", text: tool_arguments.text };
    } else if (tool.name === "new-tab") {
        cmd = { type: "agent:new-tab", url: tool_arguments.url};
    } else if (tool.name === "navigate") {
        cmd = { type: "agent:navigate", url: tool_arguments.url, new_tab: tool_arguments.new_tab !== false };
    } else if (tool.name === "scroll") {
        // x/y are grid label coords (same as click) — translate to webview CSS pixels.
        const ssPos = translateCoordinates(tool_arguments.x, tool_arguments.y, ssW, ssH);
        const scrollAtX = Math.round(ssPos.x * (winW / ssW));
        const scrollAtY = Math.round(ssPos.y * (winH / ssH));
        // delta_x/delta_y are column/row counts (can be negative).
        // One column = winW * STEP pixels; one row = winH * STEP pixels.
        // NOTE: Electron's sendInputEvent mouseWheel uses Chromium's internal convention
        // which is inverted vs the web WheelEvent: positive deltaY = scroll UP.
        // Negate so that a positive agent delta_y (meaning "scroll down") works correctly.
        const STEP = 0.015;
        const deltaXPx = -Math.round((tool_arguments.delta_x ?? 0) * winW * STEP);
        const deltaYPx = -Math.round((tool_arguments.delta_y ?? 0) * winH * STEP);
        cmd = { type: "agent:scroll", x: scrollAtX, y: scrollAtY, deltaX: deltaXPx, deltaY: deltaYPx };
    } else if (tool.name === "keypress") {
        cmd = { type: "agent:keypress", key: tool_arguments.key };
    } else if (tool.name === "wait") {
        cmd = { type: "agent:wait", seconds: tool_arguments.seconds ?? 1 };
    } else if (tool.name === "warn") {
        cmd = { type: "agent:warn", message: tool_arguments.message };
    } else if (tool.name === "final_answer") {
        cmd = { type: "agent:final_answer", text: tool_arguments.answer };
    }
    return cmd;
}

let past_actions: { tool: string; parameters: any; explanation: string; result?: string }[] = [];
let lastCursorPos: { x: number; y: number } | null = null;

let agentStopped = false;
let agentPaused = false;

export function setAgentStopped(v: boolean) { agentStopped = v; }
export function setAgentPaused(v: boolean) { agentPaused = v; }

/** Pauses the loop until unpaused or stopped. Returns true if the agent was stopped. */
async function waitIfPaused(): Promise<boolean> {
    while (agentPaused && !agentStopped) {
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return agentStopped;
}

/**
 * Waits for the DOM in the active webview's guest page to settle after an action.
 * Uses a debounced MutationObserver — resolves only once mutations have stopped
 * arriving for DEBOUNCE_MS, so small cascading changes (e.g. dropdowns, animations)
 * are fully captured before the agent takes its next screenshot.
 * Always waits at least MIN_DELAY_MS regardless of how fast the DOM settles.
 */
async function waitForDomChange(timeout: number): Promise<void> {
    const MIN_DELAY_MS = 1200;
    const DEBOUNCE_MS  = 400;   // wait this long after the last mutation before resolving
    const MAX_FROM_FIRST_MS = 3000; // hard cap from first detected mutation

    const minDelay = new Promise<void>(resolve => setTimeout(resolve, MIN_DELAY_MS));
    // Node-side timeout — guards against a stuck executeJavaScript call
    const nodeTimeout = new Promise<void>(resolve => setTimeout(resolve, timeout));
    const webviewInfo = await getActiveWebviewWc();
    if (!webviewInfo) {
        await Promise.all([minDelay, nodeTimeout]);
        return;
    }
    const guestWc = webviewInfo.wc;
    // Race the injected debounced MutationObserver against the Node-side timeout so
    // that if the JS context is destroyed (e.g. page navigation) we don't hang.
    const domChangePromise = Promise.race([
        guestWc.executeJavaScript(`
            new Promise(resolve => {
                let debounceTimer = null;
                let firstMutationTimer = null;

                const settle = () => {
                    if (debounceTimer) clearTimeout(debounceTimer);
                    if (firstMutationTimer) clearTimeout(firstMutationTimer);
                    observer.disconnect();
                    resolve();
                };

                const observer = new MutationObserver(() => {
                    // Cap total wait from first mutation so a continuously-mutating
                    // page (e.g. live ticker) doesn't stall the agent indefinitely.
                    if (!firstMutationTimer) {
                        firstMutationTimer = setTimeout(settle, ${MAX_FROM_FIRST_MS});
                    }
                    // Keep resetting the debounce window on every mutation.
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(settle, ${DEBOUNCE_MS});
                });

                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    characterData: true
                });

                // Hard outer timeout matches the caller's timeout parameter.
                setTimeout(settle, ${timeout});
            })
        `).catch(() => {}),
        nodeTimeout,
    ]);
    await Promise.all([minDelay, domChangePromise]);
}

export async function runAgentWithInstruction(instruction: string, resumeState: AgentRunResumeState = {}): Promise<string> {
    const plan = resumeState.plan ?? await buildTaskPlan(instruction);
    const tasks = plan.tasks;
    const requestedStartIndex = resumeState.startTaskIndex ?? 0;
    const startTaskIndex = Math.min(Math.max(requestedStartIndex, 0), tasks.length - 1);
    const mainWc = BrowserWindow.getAllWindows()[0]?.webContents;
    let finalAnswer = "";
    let currentTaskIndex = startTaskIndex;
    
    try {
        agentStopped = false;
        agentPaused = false;
        if (startTaskIndex > 0) {
            console.log(`Resuming agent from macro task ${startTaskIndex + 1}/${tasks.length}.`);
        }

        for (let taskIndex = startTaskIndex; taskIndex < tasks.length; taskIndex += 1) {
            currentTaskIndex = taskIndex;
            const currentTask = tasks[taskIndex];
        
            past_actions = [];
            lastCursorPos = null;
            
            while (true) {
                // Check stop flag
                if (agentStopped) break;
            
                // Wait if paused (returns true if stopped while paused)
                if (await waitIfPaused()) break;
            
                console.log("Running agent with instruction:", currentTask);
            
                let screenshotResult = await takeScreenshot();
                if (!screenshotResult) {
                    // Give the webview one more chance — wait an extra second and retry once.
                    console.warn("Failed to take screenshot, waiting 2s before one final retry...");
                    await new Promise<void>(resolve => setTimeout(resolve, 2000));
                    screenshotResult = await takeScreenshot();
                }
                if (!screenshotResult) {
                    console.error("Failed to take screenshot after all retries. Aborting agent loop.");
                    throw new Error("Failed to take screenshot after all retries.");
                }
                const { base64: screenshot, w: ssW, h: ssH, winW, winH } = screenshotResult;
            
                if (agentStopped) break;
                if (await waitIfPaused()) break;
            
                const currentUrl = (await getActiveWebviewWc())?.wc.getURL() ?? undefined;
                const openTabs: { id: string; url: string; title?: string; isActive: boolean }[] =
                    mainWc ? await mainWc.executeJavaScript('window.__tabs || []').catch(() => []) : [];
                const response = await GetAction(currentTask, screenshot, currentUrl, openTabs);
                if (!response) {
                    throw new Error("Agent action endpoint returned no response.");
                }
            
                let tool = response?.tool || null;
                console.log("Agent selected tool:", tool);
            
                let tool_arguments: any = {};
                if (tool?.arguments) {
                    tool_arguments = typeof tool.arguments === "string"
                        ? JSON.parse(tool.arguments)
                        : tool.arguments;
                }
            
                let cmd = getCommand(tool, winW, winH, ssW, ssH);
            
                if (!cmd) {
                    throw new Error(`Unknown tool name: ${tool?.name}`);
                }
            
                if (cmd.type === "agent:final_answer") {
                    console.log("Agent final answer:", cmd.text);
                    finalAnswer = cmd.text || "";
                    if (taskIndex === tasks.length - 1) {
                        return finalAnswer; // If this is the last task, we can finish immediately without waiting for the next loop iteration.
                    }
                    break; // Otherwise, break to move on to the next task (if any).
                }
            
                if (cmd.type === "agent:warn") {
                    console.log("Agent warning:", cmd.message);
                    mainWc?.send("agent:warn", cmd.message || "Agent returned a warning.");
                    break;
                }
            
                if (agentStopped) break;
                if (await waitIfPaused()) break;
            
                console.log("Executing command:", cmd);
                await executeCommand(cmd);
            
                // After a click, capture what element is now focused so the LLM
                // can confirm the click landed on a search/input box and won't re-click it.
                let actionResult: string | undefined;
                if (cmd.type === "agent:click") {
                    const webviewInfo = await getActiveWebviewWc();
                    if (webviewInfo) {
                        actionResult = await webviewInfo.wc.executeJavaScript(`
                            (() => {
                                const el = document.activeElement;
                                if (!el || el === document.body || el === document.documentElement) return "focused: nothing";
                                const tag = el.tagName.toLowerCase();
                                const type = el.getAttribute('type') || '';
                                const placeholder = el.getAttribute('placeholder') || '';
                                const role = el.getAttribute('role') || '';
                                const id = el.id ? '#' + el.id : '';
                                const name = el.getAttribute('name') || '';
                                const parts = [tag];
                                if (type) parts.push('[type=' + type + ']');
                                if (id) parts.push(id);
                                if (name) parts.push('[name=' + name + ']');
                                if (role) parts.push('[role=' + role + ']');
                                if (placeholder) parts.push('placeholder="' + placeholder + '"');
                                return 'focused: ' + parts.join('');
                            })()
                        `).catch(() => undefined);
                    }
                }
            
                const explanation = tool_arguments.explanation || "No explanation provided.";
                past_actions.push({
                    tool: tool.name,
                    parameters: tool_arguments,
                    explanation,
                    ...(actionResult !== undefined ? { result: actionResult } : {})
                });
                mainWc?.send("agent:action", explanation);
            
                // Wait for any DOM change in the webview, timeout after 1s
                await waitForDomChange(1500);
            }
        }
        return finalAnswer;
    } catch (error) {
        if (error instanceof AgentRunError) {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error ?? "Unknown agent error");
        throw new AgentRunError(message, {
            instruction,
            plan,
            resumeTaskIndex: currentTaskIndex,
            cause: error,
        });
    } finally {
        agentStopped = false;
        agentPaused = false;
    }
}