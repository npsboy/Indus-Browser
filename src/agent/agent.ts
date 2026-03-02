import { BrowserWindow } from "electron";
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

async function takeScreenshot(): Promise<{ base64: string; w: number; h: number } | null> {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) return null;
    const image = await wc.capturePage();
    const resized = image.resize({ width: 1280 });
    const w = resized.getSize().width;
    const h = resized.getSize().height;
    const rawBase64 = resized.toDataURL();
    const processedBase64 = await processScreenshotForAgent(rawBase64);

    // Save to disk for inspection
    const savePath = join(tmpdir(), "indus-agent-screenshot.jpg");
    const imgData = processedBase64.replace(/^data:image\/\w+;base64,/, "");
    writeFileSync(savePath, Buffer.from(imgData, "base64"));
    console.log("Saved processed screenshot to:", savePath);

    return { base64: processedBase64, w, h };
}

async function executeCommand(cmd: any): Promise<void> {
    const mainWc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!mainWc) return;

    if (cmd.type === "agent:new-tab") {
        console.log("Agent command: open new tab with url:", cmd.url);
        mainWc.send("agent:new-tab", cmd.url);
    } else if (cmd.type === "agent:click") {
        mainWc.sendInputEvent({ type: 'mouseDown', x: cmd.x, y: cmd.y, button: 'left', clickCount: 1 });
        mainWc.sendInputEvent({ type: 'mouseUp',   x: cmd.x, y: cmd.y, button: 'left', clickCount: 1 });
    } else if (cmd.type === "agent:type") {
        for (const char of cmd.text) {
            mainWc.sendInputEvent({ type: 'keyDown', keyCode: char });
            mainWc.sendInputEvent({ type: 'char',   keyCode: char });
            mainWc.sendInputEvent({ type: 'keyUp',  keyCode: char });
        }
    } else if (cmd.type === "agent:navigate") {
        mainWc.send("agent:navigate", cmd.url);
    } else if (cmd.type === "agent:scroll") {
        mainWc.sendInputEvent({ type: 'mouseWheel', x: cmd.x, y: cmd.y, deltaY: cmd.deltaY } as any);
    }
}

export async function runAgentWithInstruction(instruction: string): Promise<void> {
    console.log("Running agent with instruction:", instruction);

    const screenshotResult = await takeScreenshot();
    if (!screenshotResult) {
        console.error("Failed to take screenshot.");
        return;
    }
    const { base64: screenshot, w: ssW, h: ssH } = screenshotResult;

    const response = await GetAction(instruction, screenshot);
    if (!response) return;

    console.log("Raw response from agent:", response);
    let tool = response?.tool || null;
    console.log("Agent selected tool:", tool);
    if (!tool) return;

    let tool_arguments: any = {};
    if (tool?.arguments) {
        tool_arguments = typeof tool.arguments === "string"
            ? JSON.parse(tool.arguments)
            : tool.arguments;
    }

    let cmd: any;
    if (tool.name === "click") {
        cmd = { type: "agent:click", ...translateCoordinates(tool_arguments.x, tool_arguments.y, ssW, ssH) };
    } else if (tool.name === "type") {
        cmd = { type: "agent:type", text: tool_arguments.text };
    } else if (tool.name === "new-tab") {
        cmd = { type: "agent:new-tab", url: tool_arguments.url ?? response.url };
    } else if (tool.name === "navigate") {
        cmd = { type: "agent:navigate", url: tool_arguments.url };
    } else if (tool.name === "scroll") {
        cmd = { type: "agent:scroll", x: tool_arguments.x, y: tool_arguments.y, deltaY: tool_arguments.deltaY };
    }

    if (!cmd) {
        console.error("Unknown tool name:", tool.name);
        return;
    }

    console.log("Executing command:", cmd);
    await executeCommand(cmd);
}