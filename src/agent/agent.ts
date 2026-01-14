// Agent module - runs in Electron main process
import { BrowserWindow, net, screen, webContents as electronWebContents } from "electron";


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

async function computerUse(taskGoal: string, screenshot: string, win: BrowserWindow) {
    const imageUrl = screenshot.startsWith('data:') 
        ? screenshot 
        : `data:image/png;base64,${screenshot}`;
    
    const contentBounds = win.getContentBounds();
    const display = screen.getDisplayMatching(win.getBounds());
    const scaleFactor = display.scaleFactor || 1;
    const scaledWidth = Math.round(contentBounds.width * scaleFactor);
    const scaledHeight = Math.round(contentBounds.height * scaleFactor);

    try {
        const response = await net.fetch("https://indus-backend.tushar-vijayanagar.workers.dev/computer", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                goal: taskGoal,
                imageUrl: imageUrl,
                displayHeight: scaledHeight,
                displayWidth: scaledWidth
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[agent.ts] computerUse: Error response:', errorText);
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const text = await response.text();
        const data = JSON.parse(text);
        return data;
    } catch (error) {
        console.error('[agent.ts] computerUse: Fetch error:', error);
        throw error;
    }
}

async function getWebviewContainerRect(win: BrowserWindow): Promise<null | { left: number; top: number; width: number; height: number }> {
    try {
        const rect = await win.webContents.executeJavaScript(
            `(() => {
                const el = document.querySelector('.webview-container');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { left: r.left, top: r.top, width: r.width, height: r.height };
            })()`,
            true
        );
        if (!rect) return null;
        return rect;
    } catch (e) {
        console.warn("[agent.ts] Failed to read .webview-container rect:", e);
        return null;
    }
}

function pickGuestWebContentsForWindow(win: BrowserWindow) {
    const host = win.webContents;
    const all = electronWebContents.getAllWebContents();
    const guests = all.filter((wc: any) => wc?.hostWebContents === host);
    // Prefer a focused guest if available, else any guest.
    return (guests.find((wc: any) => typeof wc.isFocused === "function" && wc.isFocused()) ?? guests[0]) ?? null;
}

// Execute actions on the browser window
async function executeAction(action: any, win: BrowserWindow) {
    const hostWc = win.webContents;

    const display = screen.getDisplayMatching(win.getBounds());
    const scaleFactor = display.scaleFactor || 1;

    // Model coords are in device pixels (because you told backend scaledWidth/Height),
    // but Electron input expects DIP.
    const dipX = Math.round(action.x / scaleFactor);
    const dipY = Math.round(action.y / scaleFactor);

    // Determine whether this point is inside the webview container in the *host page*
    const rect = await getWebviewContainerRect(win);
    const inWebviewContainer =
        !!rect &&
        dipX >= rect.left &&
        dipY >= rect.top &&
        dipX <= rect.left + rect.width &&
        dipY <= rect.top + rect.height;

    const guestWc = inWebviewContainer ? pickGuestWebContentsForWindow(win) : null;

    // If sending to guest, translate host DIP -> guest-local DIP
    const targetWc = guestWc ?? hostWc;
    const localX = guestWc && rect ? Math.round(dipX - rect.left) : dipX;
    const localY = guestWc && rect ? Math.round(dipY - rect.top) : dipY;

    if (action.type === "click") {
        const button = (action.button ?? "left") as "left" | "middle" | "right";

        try {
            if (!win.isFocused()) win.focus();
            targetWc.focus();
            await new Promise((r) => setTimeout(r, 50));

            targetWc.sendInputEvent({ type: "mouseMove", x: localX, y: localY });
            await new Promise((r) => setTimeout(r, 25));

            targetWc.sendInputEvent({ type: "mouseDown", x: localX, y: localY, button, clickCount: 1, modifiers: [] });
            await new Promise((r) => setTimeout(r, 50));

            targetWc.sendInputEvent({ type: "mouseUp", x: localX, y: localY, button, clickCount: 1, modifiers: [] });
        } catch (error) {
            console.error("[agent.ts] Error executing click:", error);
            throw error;
        }
    }
    else if (action.type === "scroll") {
        try {
            if (!win.isFocused()) win.focus();
            if (guestWc) guestWc.focus();
            
            await new Promise((r) => setTimeout(r, 50));

            targetWc.sendInputEvent({
                type: "mouseWheel",
                x: localX,
                y: localY,
                deltaX: 0,
                deltaY: -(action.scrollY || action.deltaY || 100)
            });
        } catch (error) {
            console.error("[agent.ts] Error executing scroll:", error);
            throw error;
        }
    }
    else if (action.type === "navigate") {
        hostWc.send("agent:navigate", action.url);
    }
    else if (action.type === "type") {
        for (const char of action.text) {
            hostWc.sendInputEvent({
                type: 'char',
                keyCode: char
            });
        }
    }
    else if (action.type === "keypress") {
        hostWc.sendInputEvent({
            type: 'keyDown',
            keyCode: action.keyCode
        });
        hostWc.sendInputEvent({
            type: 'keyUp',
            keyCode: action.keyCode
        });
    }
    else if (action.type === "wait") {
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
        const aiDecision = await computerUse(userPrompt, screenshot, win);

        if (aiDecision && aiDecision[1]?.action) {
            const action = aiDecision[1].action;
            console.log('[agent.ts] Executing action:', action);
            await executeAction(action, win);
        } else {
            console.warn('[agent.ts] No actions found in AI decision');
        }
    } catch (error) {
        console.error('[agent.ts] Error executing task:', error);
    }
}