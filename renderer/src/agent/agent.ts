import { AgentCommand } from "../../../src/agent/agent-api";

async function planTask(userPrompt: string) {
    const response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
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
    const data = await response.json();
    return data;
}

async function computerUse(taskGoal: string, screenshot: string) {
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

// This function executes a task sent from Main process
async function executeTask(userPrompt: string, screenshot: string | null) {
    const agentapi = (window as any).agentapi;
    
    if (!agentapi) {
        console.error("Agent API not available");
        return;
    }

    console.log("Executing task:", userPrompt);

    // Use the AI to decide what to do
    if (screenshot) {
        const aiDecision = await computerUse(userPrompt, screenshot);
        console.log("AI Decision:", aiDecision);
    }

    // Parse and execute - simple keyword matching for now:
    if (userPrompt.toLowerCase().includes("new tab")) {
        await agentapi.sendAgentCommand({ type: "agent:new-tab" });
    }
    else if (userPrompt.toLowerCase().includes("close tab")) {
        await agentapi.sendAgentCommand({ type: "agent:close-active-tab" });
    }
    else if (userPrompt.toLowerCase().includes("reload")) {
        await agentapi.sendAgentCommand({ type: "agent:reload-active-tab" });
    }
}

// Listen for tasks from Main process
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
        const agentapi = (window as any).agentapi;
        if (agentapi?.onAgentTask) {
            agentapi.onAgentTask((task: string, screenshot: string) => {
                executeTask(task, screenshot);
            });
        }
    });
}

export { executeTask };
