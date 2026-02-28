import { url } from "inspector";
import { AgentCommand } from "./commands";


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

export function decideAction(input: string, screenshot: string) {
    console.log("Deciding action for input:", input);
    if (input.includes("open new tab")) {
        return { type: "agent:new-tab", url: "https://www.google.com" };  
    } else if (input.includes("click")) {
        return { type: "agent:click", x: 544, y: 26 };
    }
    else if (input.includes("type")) {
        return { type: "agent:type", text: "Hello World" };
    }
}