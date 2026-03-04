import { BrowserWindow, webContents as allWebContents } from "electron";
import { processScreenshotForAgent } from "./screenshotProcessor";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";


const agentPrompt = readFileSync(join(__dirname, "prompts/agent-prompt.md"), "utf-8");


async function planTask(userPrompt:string){
    const response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
            agentRole: "planner",
            messages: [
                { role: "system", content: "You are an expert browser agent that does tasks autonomously on the web." },
                { role: "user", content: `Based on the following input, decide some high level actions that the agent hould take.: "${userPrompt}"` }
            ]
         })
    });
    const data = await response.json();
    return data;
}

async function computerUse(taskGoal:string, screenshot:string){
    const response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/computer", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
            goal: taskGoal,
            screenshotBase64: screenshot,
        })
    });
    const data = await response.json();
    return data;
}

async function GetAction(userPrompt:string, imageurl:string){
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
                { role: "user", content: `User task: "${userPrompt}"` }
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

    // Ask the renderer for the active webview's bounding rect
    const bounds: { x: number; y: number; w: number; h: number } | null =
        await win.webContents.executeJavaScript(`
            (() => {
                const wv = document.querySelector('webview[style*="display: flex"]');
                if (!wv) return null;
                const r = wv.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height };
            })()
        `);

    if (!bounds) {
        console.error("Could not find active webview bounds");
        return null;
    }

    // Find the guest WebContents for the active webview
    const guestWc = allWebContents.getAllWebContents()
        .find(wc => wc.getType() === "webview" && wc !== win.webContents);

    if (!guestWc) {
        console.error("Could not find webview WebContents");
        return null;
    }

    return { wc: guestWc, ...bounds };
}

async function takeScreenshot(): Promise<{ base64: string; w: number; h: number; winW: number; winH: number } | null> {
    // Capture only the webview content so all coordinates are webview-relative.
    const webviewInfo = await getActiveWebviewWc();
    if (!webviewInfo) return null;
    const winW = Math.round(webviewInfo.w);
    const winH = Math.round(webviewInfo.h);
    const image = await webviewInfo.wc.capturePage();
    const resized = image.resize({ width: 1200 });
    const w = resized.getSize().width;
    const h = resized.getSize().height;
    const rawBase64 = resized.toDataURL();
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
 * Finds the center of the nearest clickable element to (targetX, targetY) in the
 * webview's page. "Clickable" means <a>, <button>, <input>, <select>, <textarea>,
 * or any element with role="button"/"link"/"menuitem"/"tab"/"checkbox"/"radio",
 * [onclick], or [tabindex]. Searches within MAX_RADIUS CSS pixels.
 * Returns the snapped {x, y} or the original coords if nothing closer is found.
 */
async function snapToClickable(
    guestWc: Electron.WebContents,
    targetX: number,
    targetY: number
): Promise<{ x: number; y: number }> {
    const MAX_RADIUS = 160;
    const CLICKABLE_ROLES = ["button","link","menuitem","menuitemcheckbox","menuitemradio","tab","checkbox","radio","option","combobox","listbox","switch","treeitem"];

    const result: { x: number; y: number } | null = await guestWc.executeJavaScript(`
        (() => {
            const tx = ${targetX}, ty = ${targetY};
            const maxR = ${MAX_RADIUS};
            const clickableRoles = ${JSON.stringify(CLICKABLE_ROLES)};

            function isClickable(el) {
                if (!el || el === document.documentElement || el === document.body) return false;
                const tag = el.tagName.toLowerCase();
                if (['a','button','input','select','textarea','label'].includes(tag)) return true;
                const role = (el.getAttribute('role') || '').toLowerCase();
                if (clickableRoles.includes(role)) return true;
                if (el.hasAttribute('onclick')) return true;
                const ti = el.getAttribute('tabindex');
                if (ti !== null && ti !== '-1') return true;
                return false;
            }

            function rectCenter(r) {
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }

            function dist(cx, cy) {
                return Math.sqrt((cx - tx) ** 2 + (cy - ty) ** 2);
            }

            // 1. Walk up from the element exactly at the target point.
            let el = document.elementFromPoint(tx, ty);
            while (el && el !== document.documentElement) {
                if (isClickable(el)) {
                    const c = rectCenter(el.getBoundingClientRect());
                    return { x: Math.round(c.x), y: Math.round(c.y) };
                }
                el = el.parentElement;
            }

            // 2. Scan all clickable elements and pick the closest within maxR.
            const selector = 'a,button,input,select,textarea,label,[role],[onclick],[tabindex]';
            const candidates = Array.from(document.querySelectorAll(selector));
            let bestDist = maxR + 1;
            let bestCenter = null;
            for (const c of candidates) {
                if (!isClickable(c)) continue;
                const r = c.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const d = dist(cx, cy);
                if (d < bestDist) {
                    bestDist = d;
                    bestCenter = { x: Math.round(cx), y: Math.round(cy) };
                }
            }
            return bestCenter;
        })()
    `).catch(() => null);

    if (result) {
        console.log(`[Agent] Snapped click from (${targetX},${targetY}) → (${result.x},${result.y})`);
        return result;
    }
    return { x: targetX, y: targetY };
}

async function executeCommand(cmd: any): Promise<void> {
    const mainWc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!mainWc) return;

    if (cmd.type === "agent:new-tab") {
        mainWc.send("agent:new-tab", cmd.url);
    } else if (cmd.type === "agent:click") {
        // cmd.x/y are already webview-relative (screenshot was captured from the webview).
        // Snap to the nearest clickable element before dispatching.
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) {
            console.error("Cannot click: no active webview found");
            return;
        }
        const snapped = await snapToClickable(webviewInfo.wc, cmd.x, cmd.y);
        const relX = snapped.x;
        const relY = snapped.y;
        lastCursorPos = { x: relX, y: relY };
        webviewInfo.wc.sendInputEvent({ type: 'mouseMove', x: relX, y: relY });
        webviewInfo.wc.sendInputEvent({ type: 'mouseDown', x: relX, y: relY, button: 'left', clickCount: 1 });
        webviewInfo.wc.sendInputEvent({ type: 'mouseUp',   x: relX, y: relY, button: 'left', clickCount: 1 });
        // Flash cursor in the renderer at window-space position (webview offset + relative coords)
        mainWc.send("agent:cursor-flash", { x: Math.round(webviewInfo.x + relX), y: Math.round(webviewInfo.y + relY) });
    } else if (cmd.type === "agent:type") {
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) return;
        for (const char of cmd.text) {
            webviewInfo.wc.sendInputEvent({ type: 'keyDown', keyCode: char });
            webviewInfo.wc.sendInputEvent({ type: 'char',   keyCode: char });
            webviewInfo.wc.sendInputEvent({ type: 'keyUp',  keyCode: char });
        }
    } else if (cmd.type === "agent:navigate") {
        mainWc.send("agent:navigate", cmd.url);
    } else if (cmd.type === "agent:scroll") {
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) return;
        // Focus the webContents so scroll events are routed correctly.
        webviewInfo.wc.focus();
        // Move mouse to the scroll target first so the renderer picks the right element.
        webviewInfo.wc.sendInputEvent({ type: 'mouseMove', x: cmd.x, y: cmd.y, movementX: 0, movementY: 0 } as any);
        // cmd.x/y are already webview-relative — no offset subtraction needed.
        webviewInfo.wc.sendInputEvent({ type: 'mouseWheel', x: cmd.x, y: cmd.y, deltaX: cmd.deltaX ?? 0, deltaY: cmd.deltaY ?? 0, canScroll: true } as any);
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
        cmd = { type: "agent:navigate", url: tool_arguments.url };
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
    } else if (tool.name === "warn") {
        cmd = { type: "agent:warn", message: tool_arguments.message };
    } else if (tool.name === "final_answer") {
        cmd = { type: "agent:final_answer", text: tool_arguments.answer };
    }
    return cmd;
}

let past_actions: { tool: string; parameters: any; explanation: string }[] = [];
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

export async function runAgentWithInstruction(instruction: string): Promise<void> {
    past_actions = [];
    lastCursorPos = null;
    agentStopped = false;
    agentPaused = false;
    const mainWc = BrowserWindow.getAllWindows()[0]?.webContents;
    let finalAnswer = "";
    try {
        while (true) {
            // Check stop flag
            if (agentStopped) break;

            // Wait if paused (returns true if stopped while paused)
            if (await waitIfPaused()) break;

            console.log("Running agent with instruction:", instruction);

            const screenshotResult = await takeScreenshot();
            if (!screenshotResult) {
                console.error("Failed to take screenshot.");
                break;
            }
            const { base64: screenshot, w: ssW, h: ssH, winW, winH } = screenshotResult;

            if (agentStopped) break;
            if (await waitIfPaused()) break;

            const response = await GetAction(instruction, screenshot);
            if (!response) break;

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
                console.error("Unknown tool name:", tool.name);
                break;
            }

            if (cmd.type === "agent:final_answer") {
                console.log("Agent final answer:", cmd.text);
                finalAnswer = cmd.text || "";
                break;
            }

            if (cmd.type === "agent:warn") {
                console.log("Agent warning:", cmd.message);
                break;
            }

            if (agentStopped) break;
            if (await waitIfPaused()) break;

            console.log("Executing command:", cmd);
            await executeCommand(cmd);

            const explanation = tool_arguments.explanation || "No explanation provided.";
            past_actions.push({
                tool: tool.name,
                parameters: tool_arguments,
                explanation
            });
            mainWc?.send("agent:action", explanation);

            // Wait for any DOM change in the webview, timeout after 1s
            await waitForDomChange(1500);
        }
    } finally {
        agentStopped = false;
        agentPaused = false;
        mainWc?.send("agent:done", finalAnswer);
    }
}