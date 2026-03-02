import { url } from "inspector";
import { AgentCommand } from "./commands";
import { processScreenshotForAgent } from "./screenshotProcessor";
import { readFileSync } from "fs";
import { join } from "path";


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

export async function decideAction(input: string, screenshot: string, screenshotW: number, screenshotH: number) {
    console.log("Deciding action for input:", input);
    try {
        const response = await GetAction(input, screenshot);
        console.log("Raw response from agent:", response);
        let tool = response?.tool || null;
        console.log("Agent selected tool:", tool);
        let tool_arguments: any = {};
        if (tool?.arguments) {
            tool_arguments = typeof tool.arguments === "string"
                ? JSON.parse(tool.arguments)
                : tool.arguments;
        }
        let action;
        if (tool.name === "click") {
            action = {
                type: "agent:click",
                ...translateCoordinates(tool_arguments.x, tool_arguments.y, screenshotW, screenshotH)
            };
        } else if (tool.name === "type") {
            action = {
                type: "agent:type",
                text: tool_arguments.text
            };
        } else if (tool.name === "new-tab") {
            action = {
                type: "agent:new-tab",
                url: response.url
            };
        } else if (tool.name === "navigate") {
            action = {
                type: "agent:navigate",
                url: tool_arguments.url
            };
        } else if (tool.name === "scroll") {
            action = {
                type: "agent:scroll",
                x: tool_arguments.x,
                y: tool_arguments.y,
                deltaY: tool_arguments.deltaY
            };
        }
        console.log("Received action from agent:", action);
        return action;
    } catch (err) {
        console.error("Error getting action from agent:", err);
        return null;
    }
}