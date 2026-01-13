// Agent module - runs in Electron main process
import { BrowserWindow, net } from "electron";


async function planTask(userPrompt: string) {
    try {
        const response = await net.fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                agentRole: "planner",
                messages: [
                    { role: "system", content: "You are an expert browser agent that does tasks autonomously on the web." },
                    { role: "user", content: `Based on the following input, decide some high level actions that the agent should take.: "${userPrompt}"` }
                ]
            })
        });
        
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[agent.ts] planTask: Error response:', errorText);
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('[agent.ts] planTask: Fetch error:', error);
        throw error;
    }
}

async function computerUse(taskGoal: string, screenshot: string) {
    console.log('[agent.ts] computerUse: Sending request...');
    console.log('[agent.ts] computerUse: Goal:', taskGoal);
    
    // Ensure screenshot is in data URL format
    const imageUrl = screenshot.startsWith('data:') 
        ? screenshot 
        : `data:image/png;base64,${screenshot}`;
    
    try {
        const response = await net.fetch("https://indus-backend.tushar-vijayanagar.workers.dev/computer", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                goal: taskGoal,
                screenshot: imageUrl,  // Changed from screenshotBase64 to screenshot with data URL
            })
        });
        
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[agent.ts] computerUse: Error response:', errorText);
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const text = await response.text();
        
        const data = JSON.parse(text);
        console.log('[agent.ts] computerUse: Parsed response:', data);
        return data;
    } catch (error) {
        console.error('[agent.ts] computerUse: Fetch error:', error);
        throw error;
    }
}

// Execute actions on the browser window
async function executeAction(action: any, win: BrowserWindow) {
    const wc = win.webContents;
    
    if (action.type === "click") {
        console.log('[agent.ts] Executing click at', action.x, action.y);
        wc.sendInputEvent({
            type: 'mouseDown',
            x: action.x,
            y: action.y,
            button: 'left',
            clickCount: 1
        });
        wc.sendInputEvent({
            type: 'mouseUp',
            x: action.x,
            y: action.y,
            button: 'left',
            clickCount: 1
        });
    }
    else if (action.type === "scroll") {
        console.log('[agent.ts] Executing scroll');
        wc.sendInputEvent({
            type: 'mouseWheel',
            x: action.x,
            y: action.y,
            deltaX: 0,
            deltaY: action.scrollY || action.deltaY
        });
    }
    else if (action.type === "navigate") {
        console.log('[agent.ts] Navigating to', action.url);
        wc.send("agent:navigate", action.url);
    }
    else if (action.type === "type") {
        console.log('[agent.ts] Typing text');
        // Send each character as a key event
        for (const char of action.text) {
            wc.sendInputEvent({
                type: 'char',
                keyCode: char
            });
        }
    }
    else if (action.type === "keypress") {
        console.log('[agent.ts] Pressing key', action.keyCode);
        wc.sendInputEvent({
            type: 'keyDown',
            keyCode: action.keyCode
        });
        wc.sendInputEvent({
            type: 'keyUp',
            keyCode: action.keyCode
        });
    }
    else if (action.type === "wait") {
        console.log('[agent.ts] Waiting 2 seconds');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

// Main function to execute a task from the UI
export async function executeTask(userPrompt: string, screenshot: string | null, win: BrowserWindow) {
    console.log('[agent.ts] ========================================');
    console.log('[agent.ts] RECEIVED TASK:', userPrompt);
    console.log('[agent.ts] ========================================');

    if (!screenshot) {
        console.error('[agent.ts] No screenshot provided');
        return;
    }

    try {
        const aiDecision = await computerUse(userPrompt, screenshot);

        if (aiDecision && aiDecision[0]?.action) {
            const action = aiDecision[0].action;
            console.log('[agent.ts] Executing action:', action);
            await executeAction(action, win);
        } else {
            console.warn('[agent.ts] No actions found in AI decision');
        }
    } catch (error) {
        console.error('[agent.ts] Error executing task:', error);
    }
}