import { AgentCommand } from "./commands";

export function decideAction(input: string): AgentCommand {
    if (input.includes("new tab")) {
        return { type: "agent:new-tab" };
    }
    if (input.includes("close tab")) {
        return { type: "agent:close-active-tab" };
    }
}