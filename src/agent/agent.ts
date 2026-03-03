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
                { role: "system", content: agentPrompt },
                { role: "system", content: "Previous actions: " + past_actions.join("\n") },
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

/** Reverse of gridLabel(): parse "2c" → 0-based grid index */
function parseLabelIndex(label: string): number {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const match = label.match(/^(\d+)([a-z])$/);
    if (!match) throw new Error(`Invalid grid label: "${label}"`);
    const numPart    = parseInt(match[1], 10);   // e.g. 2
    const letterPart = match[2];                 // e.g. "c"
    const letterIdx  = letters.indexOf(letterPart); // 0-based
    return (numPart - 1) * 26 + letterIdx;       // 0-based grid-line index
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
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const wc = win.webContents;
    // getContentSize() returns logical/CSS pixels — the same coordinate space
    // that sendInputEvent expects, regardless of display DPR/scaling.
    const [winW, winH] = win.getContentSize();
    const image = await wc.capturePage();
    const resized = image.resize({ width: 1200 });
    const w = resized.getSize().width;
    const h = resized.getSize().height;
    const rawBase64 = resized.toDataURL();
    const processedBase64 = await processScreenshotForAgent(rawBase64);

    // Save to disk for inspection
    const savePath = join(tmpdir(), "indus-agent-screenshot.jpg");
    const imgData = processedBase64.replace(/^data:image\/\w+;base64,/, "");
    writeFileSync(savePath, Buffer.from(imgData, "base64"));
    console.log("Saved processed screenshot to:", savePath);
    console.log(`Screenshot: resized=${w}x${h}, window(logical)=${winW}x${winH}, scale=${(winW/w).toFixed(3)}x${(winH/h).toFixed(3)}`);

    return { base64: processedBase64, w, h, winW, winH };
}

async function executeCommand(cmd: any): Promise<void> {
    const mainWc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!mainWc) return;

    if (cmd.type === "agent:new-tab") {
        console.log("Agent command: open new tab with url:", cmd.url);
        mainWc.send("agent:new-tab", cmd.url);
    } else if (cmd.type === "agent:click") {
        // sendInputEvent on the main WebContents does NOT reach <webview> guest pages
        // (they are out-of-process). We must send to the guest WebContents directly,
        // with coordinates relative to the webview, not the full window.
        const webviewInfo = await getActiveWebviewWc();
        if (!webviewInfo) {
            console.error("Cannot click: no active webview found");
            return;
        }
        const relX = Math.round(cmd.x - webviewInfo.x);
        const relY = Math.round(cmd.y - webviewInfo.y);
        console.log(`Sending click to webview WebContents: window=(${cmd.x},${cmd.y}) webviewOffset=(${webviewInfo.x},${webviewInfo.y}) relative=(${relX},${relY})`);
        webviewInfo.wc.sendInputEvent({ type: 'mouseMove', x: relX, y: relY });
        webviewInfo.wc.sendInputEvent({ type: 'mouseDown', x: relX, y: relY, button: 'left', clickCount: 1 });
        webviewInfo.wc.sendInputEvent({ type: 'mouseUp',   x: relX, y: relY, button: 'left', clickCount: 1 });
        // Flash cursor icon in the renderer at the window-space click position
        mainWc.send("agent:cursor-flash", { x: cmd.x, y: cmd.y });
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
        const relX = Math.round(cmd.x - webviewInfo.x);
        const relY = Math.round(cmd.y - webviewInfo.y);
        webviewInfo.wc.sendInputEvent({ type: 'mouseWheel', x: relX, y: relY, deltaY: cmd.deltaY } as any);
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
        // translateCoordinates returns coords in the resized-screenshot space (1280px wide).
        // Scale back to the logical window size (CSS pixels) for sendInputEvent.
        const ssCoords = translateCoordinates(tool_arguments.x, tool_arguments.y, ssW, ssH);
        const clickX = Math.round(ssCoords.x * (winW / ssW));
        const clickY = Math.round(ssCoords.y * (winH / ssH));
        console.log(`Click: label=(${tool_arguments.x},${tool_arguments.y}) → ss=(${ssCoords.x},${ssCoords.y}) → window=(${clickX},${clickY})`);
        cmd = { type: "agent:click", x: clickX, y: clickY };
    } else if (tool.name === "type") {
        cmd = { type: "agent:type", text: tool_arguments.text };
    } else if (tool.name === "new-tab") {
        cmd = { type: "agent:new-tab", url: tool_arguments.url};
    } else if (tool.name === "navigate") {
        cmd = { type: "agent:navigate", url: tool_arguments.url };
    } else if (tool.name === "scroll") {
        // Scale scroll coordinates from screenshot space to logical window space.
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

/**
 * Waits for the active webview's guest WebContents to emit any of
 * did-navigate, did-navigate-in-page, or did-finish-load.
 * Resolves early when one fires; falls back to the given timeout (ms).
 */
async function waitForWebviewUpdate(timeout: number): Promise<void> {
    const webviewInfo = await getActiveWebviewWc();
    if (!webviewInfo) {
        // No webview found — just wait the full timeout
        await new Promise(resolve => setTimeout(resolve, timeout));
        return;
    }
    const guestWc = webviewInfo.wc;
    return new Promise<void>(resolve => {
        let resolved = false;
        const done = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve();
        };
        const cleanup = () => {
            guestWc.off("did-navigate",         done);
            guestWc.off("did-navigate-in-page", done);
            guestWc.off("did-finish-load",      done);
        };
        guestWc.once("did-navigate",         done);
        guestWc.once("did-navigate-in-page", done);
        guestWc.once("did-finish-load",      done);
        setTimeout(done, timeout);
    });
}

export async function runAgentWithInstruction(instruction: string): Promise<void> {
    past_actions = [];
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

        console.log("Raw response from agent:", response);
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

        let description = tool_arguments.description || "No explanation provided.";
        past_actions.push(description);

        // Wait for the webview to update (navigation or load complete), timeout after 1.5s
        await waitForWebviewUpdate(10000);
    }
}