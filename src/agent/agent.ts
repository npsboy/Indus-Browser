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
                        ? "\n\nPrevious actions taken so far:\n" + past_actions.map((a, i) => `${i + 1}. ${a}`).join("\n")
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

async function executeCommand(cmd: any): Promise<void> {
    const mainWc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!mainWc) return;

    if (cmd.type === "agent:new-tab") {
        mainWc.send("agent:new-tab", cmd.url);
    } else if (cmd.type === "agent:click") {
        // cmd.x/y are already webview-relative (screenshot was captured from the webview).
        // Send directly to the guest WebContents without any offset adjustment.
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) {
            console.error("Cannot click: no active webview found");
            return;
        }
        const relX = cmd.x;
        const relY = cmd.y;
        lastCursorPos = { x: relX, y: relY };
        webviewInfo.wc.sendInputEvent({ type: 'mouseMove', x: relX, y: relY });
        webviewInfo.wc.sendInputEvent({ type: 'mouseDown', x: relX, y: relY, button: 'left', clickCount: 1 });
        webviewInfo.wc.sendInputEvent({ type: 'mouseUp',   x: relX, y: relY, button: 'left', clickCount: 1 });
        // Flash cursor in the renderer at window-space position (webview offset + relative coords)
        mainWc.send("agent:cursor-flash", { x: Math.round(webviewInfo.x + relX), y: Math.round(webviewInfo.y + relY) });
    } else if (cmd.type === "agent:type") {
        for (const char of cmd.text) {
            mainWc.sendInputEvent({ type: 'keyDown', keyCode: char });
            mainWc.sendInputEvent({ type: 'char',   keyCode: char });
            mainWc.sendInputEvent({ type: 'keyUp',  keyCode: char });
        }
    } else if (cmd.type === "agent:navigate") {
        mainWc.send("agent:navigate", cmd.url);
    } else if (cmd.type === "agent:scroll") {
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) return;
        // cmd.x/y are already webview-relative — no offset subtraction needed.
        webviewInfo.wc.sendInputEvent({ type: 'mouseWheel', x: cmd.x, y: cmd.y, deltaY: cmd.deltaY } as any);
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
        // Scale scroll coordinates from screenshot space to webview CSS pixels.
        const scrollX = Math.round(tool_arguments.x * (winW / ssW));
        const scrollY = Math.round(tool_arguments.y * (winH / ssH));
        cmd = { type: "agent:scroll", x: scrollX, y: scrollY, deltaY: tool_arguments.deltaY };
    } else if (tool.name === "warn") {
        cmd = { type: "agent:warn", message: tool_arguments.message };
    } else if (tool.name === "final_answer") {
        cmd = { type: "agent:final_answer", text: tool_arguments.answer };
    }
    return cmd;
}

let past_actions = [];
let lastCursorPos: { x: number; y: number } | null = null;

/**
 * Waits for any DOM mutation in the active webview's guest page using
 * a MutationObserver injected via executeJavaScript.
 * Resolves once a DOM change is detected (or timeout fires), but always
 * waits at least 1.5 seconds regardless.
 */
async function waitForDomChange(timeout: number): Promise<void> {
    const minDelay = new Promise<void>(resolve => setTimeout(resolve, 1500));
    // Node-side timeout — always fires, guards against a stuck executeJavaScript
    const nodeTimeout = new Promise<void>(resolve => setTimeout(resolve, timeout));
    const webviewInfo = await getActiveWebviewWc();
    if (!webviewInfo) {
        await Promise.all([minDelay, nodeTimeout]);
        return;
    }
    const guestWc = webviewInfo.wc;
    // Race the injected MutationObserver against the Node-side timeout so that
    // if the JS context is destroyed (e.g. page navigation), we don't hang.
    const domChangePromise = Promise.race([
        guestWc.executeJavaScript(`
            new Promise(resolve => {
                const observer = new MutationObserver(() => {
                    observer.disconnect();
                    resolve();
                });
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    characterData: true
                });
                setTimeout(() => { observer.disconnect(); resolve(); }, ${timeout});
            })
        `).catch(() => {}),
        nodeTimeout,
    ]);
    await Promise.all([minDelay, domChangePromise]);
}

export async function runAgentWithInstruction(instruction: string): Promise<void> {
    past_actions = [];
    lastCursorPos = null;
    while (true) {
        console.log("Running agent with instruction:", instruction);

        const screenshotResult = await takeScreenshot();
        if (!screenshotResult) {
            console.error("Failed to take screenshot.");
            return;
        }
        const { base64: screenshot, w: ssW, h: ssH, winW, winH } = screenshotResult;

        const response = await GetAction(instruction, screenshot);
        if (!response) return;

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
            return;
        }

        if (cmd.type === "agent:final_answer") {
            console.log("Agent final answer:", cmd.text);
            return;
        }

        if (cmd.type === "agent:warn") {
            console.log("Agent warning:", cmd.message);
            return;
        }

        console.log("Executing command:", cmd);
        await executeCommand(cmd);

        let explanation = tool_arguments.explanation || "No explanation provided.";
        past_actions.push(explanation);
        BrowserWindow.getAllWindows()[0]?.webContents.send("agent:action", explanation);

        // Wait for any DOM change in the webview, timeout after 10s
        await waitForDomChange(5000);
    }
}