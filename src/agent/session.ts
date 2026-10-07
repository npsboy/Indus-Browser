/**
 * Agent sessions: each sidebar conversation is one session. A new agent run
 * gets the conversation so far (not just the latest message), so follow-ups like
 * "my bad, I meant wired earphones" are read against the earlier request.
 */

import { readFileSync } from "fs";
import { join } from "path";

/** A message from the sidebar conversation, as the renderer stores it. */
export type AgentHistoryMessage = {
    role: "user" | "agent" | "reply" | "warning" | "supervisor";
    text: string;
};

export type AgentRunRequest = {
    /** The sidebar conversation this run belongs to. Each one has its own agent. */
    sessionId: string;
    /** The user's latest message. */
    text: string;
    /** The conversation before the latest message, oldest first. */
    history?: AgentHistoryMessage[];
    /** The session's notepad, carried over from earlier runs. */
    notes?: string;
};

const MAX_TURNS = 20;
const MAX_STEPS_PER_TURN = 6;
const MAX_MESSAGE_CHARS = 600;
const MAX_STEP_CHARS = 160;

const clip = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const GUIDANCE = readFileSync(join(__dirname, "prompts/session-guidance.md"), "utf-8").trim();

/**
 * Builds the instruction for a run: the latest message plus the conversation it
 * belongs to. With no prior conversation it's just the message itself.
 */
export function buildSessionInstruction(text: string, history: AgentHistoryMessage[] = []): string {
    type Turn = { request: string; steps: string[]; reply?: string; warning?: string };
    const turns: Turn[] = [];
    for (const message of history) {
        if (message.role === "user") {
            turns.push({ request: message.text, steps: [] });
            continue;
        }
        const turn = turns[turns.length - 1];
        if (!turn) continue;
        if (message.role === "agent") turn.steps.push(message.text);
        else if (message.role === "reply") turn.reply = message.text;
        else if (message.role === "warning") turn.warning = message.text;
    }

    // A handoff from chat sends the same message as both the last request and the latest one.
    const last = turns[turns.length - 1];
    const latestIsRepeat = !!last && last.request.trim() === text.trim();
    if (latestIsRepeat && last.steps.length === 0 && !last.reply && !last.warning) turns.pop();
    if (turns.length === 0) return text;

    const lines = turns.slice(-MAX_TURNS).map((turn, i) => {
        const out = [`${i + 1}. User: ${clip(turn.request, MAX_MESSAGE_CHARS)}`];
        if (turn === last && latestIsRepeat) out[0] += " (same as the latest message)";
        if (turn.steps.length > 0) {
            const shown = turn.steps.slice(-MAX_STEPS_PER_TURN).map(s => clip(s, MAX_STEP_CHARS));
            const label = turn.steps.length > shown.length
                ? `Agent steps (last ${shown.length} of ${turn.steps.length})`
                : "Agent steps";
            out.push(`   ${label}: ${shown.join(" → ")}`);
            if (turn.reply) out.push(`   Agent finished and answered: ${clip(turn.reply, MAX_MESSAGE_CHARS)}`);
            else if (turn.warning) out.push(`   Agent stopped with a warning: ${clip(turn.warning, MAX_MESSAGE_CHARS)}`);
            else out.push("   Ended WITHOUT an answer: stopped by the user or interrupted before finishing.");
        } else if (turn.reply) {
            out.push(`   Assistant replied in chat (no browser actions taken): ${clip(turn.reply, MAX_MESSAGE_CHARS)}`);
        } else if (turn.warning) {
            out.push(`   Warning: ${clip(turn.warning, MAX_MESSAGE_CHARS)}`);
        } else {
            out.push("   Ended WITHOUT an answer: stopped before taking any steps.");
        }
        return out.join("\n");
    });

    const omitted = turns.length > MAX_TURNS ? `(${turns.length - MAX_TURNS} earlier messages omitted)\n` : "";
    return [
        "Conversation so far in this session (oldest first):",
        omitted + lines.join("\n"),
        "",
        `Latest message from the user: "${text}"`,
        "",
        GUIDANCE,
    ].join("\n");
}
