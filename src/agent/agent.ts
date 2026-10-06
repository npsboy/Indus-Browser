import { webContents as allWebContents, screen as electronScreen } from "electron";
import { getMainWindow } from "../windows";
import { processScreenshotForAgent } from "./screenshotProcessor";
import {
    armPageChangeWatch,
    confirmLabeledClick,
    drawElementLabels,
    extractInteractiveElements,
    formatElementList,
    resolveLabeledElementPoint,
    stopPageChangeWatch,
    waitForPageChange,
    type LabeledElement,
    type LabelMap,
    type ResolvedLabelPoint,
} from "./elementLabeler";
import { pressKeyInBackground, scrollInBackground, typeInBackground } from "./backgroundInput";
import { GRID_MODE_TOOLS } from "./gridTools";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * How the model picks what to click:
 * - "labels": every interactive element is boxed and numbered on the screenshot; the model returns a label.
 * - "grid":   legacy mode — a lettered grid is drawn over the screenshot and the model returns grid coordinates.
 */
type TargetingMode = "labels" | "grid";
const TARGETING_MODE: TargetingMode = "labels";

const agentPrompt = readFileSync(join(__dirname, TARGETING_MODE === "labels" ? "prompts/agent-prompt.md" : "prompts/agent-prompt-grid.md"), "utf-8");

/** Task-specific tips, kept out of the main prompt and sent only while they apply (see tipsContext). */
interface TaskTip { id: string; description: string; text: string }
const taskTips: TaskTip[] = readFileSync(join(__dirname, "prompts/task-tips.md"), "utf-8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/^## /m)
    .slice(1)
    .map(section => {
        const [header, ...body] = section.split("\n");
        const [id, description = ""] = header.split("|");
        return {
            id: id.trim(),
            description: description.trim(),
            text: body.join("\n").trim(),
        };
    });
const plannerPrompt =readFileSync(join(__dirname, "prompts/planner-prompt.md"), "utf-8");
const completionCheckPrompt = readFileSync(join(__dirname, "prompts/completion-check-prompt.md"), "utf-8");
const supervisorPrompt = readFileSync(join(__dirname, TARGETING_MODE === "labels" ? "prompts/supervisor-prompt.md" : "prompts/supervisor-prompt-grid.md"), "utf-8");

export type AgentTaskPlan = {
    complexity: string;
    tasks: string[];
};

export type AgentRunResumeState = {
    plan?: AgentTaskPlan;
    startTaskIndex?: number;
    /** The agent's notepad at the time the previous attempt failed. */
    notes?: string;
};

export class AgentRunError extends Error {
    readonly instruction: string;
    readonly plan: AgentTaskPlan;
    readonly resumeTaskIndex: number;
    readonly notes: string;

    constructor(message: string, options: {
        instruction: string;
        plan: AgentTaskPlan;
        resumeTaskIndex: number;
        notes: string;
        cause?: unknown;
    }) {
        super(message);
        this.name = "AgentRunError";
        this.instruction = options.instruction;
        this.plan = options.plan;
        this.resumeTaskIndex = options.resumeTaskIndex;
        this.notes = options.notes;
        if (options.cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = options.cause;
        }
    }
}

class AgentStoppedError extends Error {
    constructor(message = "Agent stopped by user") {
        super(message);
        this.name = "AgentStoppedError";
    }
}

class AgentPausedError extends Error {
    constructor(message = "Agent paused by user") {
        super(message);
        this.name = "AgentPausedError";
    }
}


/** What the UI reports about an agent's own tab. */
export type AgentTabSurface =
    | { mode: "webview"; wcId: number | null; x: number; y: number; w: number; h: number; visible: boolean }
    /** The New Tab page, on screen (it's part of the browser window, not a webview). */
    | { mode: "renderer"; x: number; y: number; w: number; h: number }
    /** A browser page (New Tab, History, ...) that isn't on screen, so there's nothing to see or use. */
    | { mode: "internal"; url: string }
    | { mode: "closed" };

export type AgentTabInfo = { id: string; url: string; title?: string; isActive: boolean; isAgentTab: boolean };

/** How an agent reaches its own tab. Implemented by main against the UI. */
export type AgentTabBridge = {
    surface(): Promise<AgentTabSurface | null>;
    /** Opens `url` in a new tab, which becomes the agent's tab. */
    openTab(url: string): Promise<void>;
    /** Loads `url` (or "back") in the agent's tab. */
    navigate(url: string): Promise<void>;
    /** Makes an open tab showing `url` the agent's tab. False if there's none it may use. */
    switchToTab(url: string): Promise<boolean>;
    listTabs(): Promise<AgentTabInfo[]>;
};

export type AgentRuntimeOptions = {
    /** Sends an agent event to the UI; main tags it with the agent's conversation. */
    emit: (channel: string, payload?: unknown) => void;
    tabs: AgentTabBridge;
};

export type AgentRuntime = {
    run(instruction: string, resumeState?: AgentRunResumeState): Promise<string>;
    setStopped(stopped: boolean): void;
    setPaused(paused: boolean): void;
    isStopped(): boolean;
};

/** The agent's tab was closed under it; retrying won't help. */
export class AgentTabClosedError extends Error {
    constructor() {
        super("The agent's tab was closed.");
        this.name = "AgentTabClosedError";
    }
}

/**
 * Creates one agent. Each sidebar conversation gets its own, so several can run
 * at once — each in its own tab, with its own plan, actions, notepad and labels.
 */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
    const { emit, tabs } = options;

    let pendingFetchAbortController: AbortController | null = null;

    function throwIfStopped(): void {
        if (agentStopped) {
            throw new AgentStoppedError();
        }
        if (agentPaused) {
            throw new AgentPausedError();
        }
    }

    async function sleepInterruptible(ms: number, stepMs = 100): Promise<void> {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            throwIfStopped();
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(stepMs, end - Date.now())));
        }
        throwIfStopped();
    }

    async function planTask(userPrompt: string): Promise<{ complexity: string; tasks?: string[]; notes_edits?: unknown } | null> {
        throwIfStopped();
        pendingFetchAbortController = new AbortController();
        let response: Response;
        try {
            response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    agentRole: "planner",
                    messages: [
                        { role: "system", content: plannerPrompt },
                        {
                            role: "user",
                            // On a follow-up, the notepad says what's already done (including the
                            // previous plan's checklist), so the new plan covers only what's left.
                            content: `This is the user's request. "${userPrompt}"` + (agentNotes
                                ? `\n\nThe agent's notepad from earlier in this conversation (what was already done and found):\n${agentNotes}`
                                : ""),
                        }
                    ]
                }),
                signal: pendingFetchAbortController.signal,
            });
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                if (agentStopped) throw new AgentStoppedError();
                if (agentPaused) throw new AgentPausedError();
            }
            throw error;
        } finally {
            pendingFetchAbortController = null;
        }

        throwIfStopped();
        const data = await response.json();
        try {
            let replyStr: string;
            if (typeof data.reply === "string") {
                replyStr = data.reply;
            } else {
                replyStr = JSON.stringify(data.reply);
            }
            return JSON.parse(replyStr) as { complexity: string; tasks?: string[]; notes_edits?: unknown };
        } catch (e) {
            console.error("Failed to parse planner reply:", e);
            return null;
        }
    }

    async function runSupervisor(mainTask: string, plan: AgentTaskPlan, currentTaskIndex: number, screenshot: string) {
        throwIfStopped();
        const currentTask = plan.tasks[currentTaskIndex] ?? "";
        const recentActions = past_actions.slice(-15);
        pendingFetchAbortController = new AbortController();
        let response: Response;
        try {
            response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    agentRole: "supervisor",
                    messages: [
                        { role: "system", content: supervisorPrompt },
                        {
                            role: "user",
                            content: [
                                `Main task: ${JSON.stringify(mainTask)}`,
                                `Current macro task index: ${currentTaskIndex}`,
                                `Current macro task: ${JSON.stringify(currentTask)}`,
                                `Full plan: ${JSON.stringify(plan.tasks)}`,
                                `Recent actions: ${JSON.stringify(recentActions)}`,
                                `Agent's notepad (its short-term memory):\n${agentNotes || "(empty)"}`,
                                "Determine if the actions indicate abnormal repetition. If yes, return a refined prompt for only the current macro task. If the notepad is wrong, stale or missing something that keeps the agent stuck, fix it with notes_edits."
                            ].join("\n")
                        }
                    ],
                    imageUrl: screenshot
                }),
                signal: pendingFetchAbortController.signal,
            });
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                if (agentStopped) throw new AgentStoppedError();
                if (agentPaused) throw new AgentPausedError();
            }
            throw error;
        } finally {
            pendingFetchAbortController = null;
        }

        throwIfStopped();
        if (!response.ok) {
            const errText = await response.text();
            console.error(`Supervisor endpoint error ${response.status}:`, errText);
            return null;
        }

        const data = await response.json();
        try {
            let replyStr: string;
            if (typeof data.reply === "string") {
                replyStr = data.reply;
            } else {
                replyStr = JSON.stringify(data.reply);
            }
            return JSON.parse(replyStr) as { abnormal_repetition: boolean; refined_prompt?: string; notes_edits?: unknown };
        } catch (e) {
            console.error("Failed to parse supervisor reply:", e);
            return null;
        }
    }

    /**
     * Asks a checker model whether the final answer really covers the whole request
     * (as combined with the conversation). Null if the check itself fails — then the
     * answer is accepted rather than blocking the run.
     */
    async function checkCompletion(overallRequest: string, answer: string): Promise<{ complete: boolean; remaining?: string } | null> {
        throwIfStopped();
        pendingFetchAbortController = new AbortController();
        let response: Response;
        try {
            response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    agentRole: "supervisor",
                    messages: [
                        { role: "system", content: completionCheckPrompt },
                        {
                            role: "user",
                            content: [
                                `Overall request:\n${overallRequest}`,
                                `Agent's notepad:\n${agentNotes || "(empty)"}`,
                                `Recent actions: ${JSON.stringify(past_actions.slice(-12))}`,
                                `Final answer: ${JSON.stringify(answer)}`,
                            ].join("\n\n"),
                        },
                    ],
                }),
                signal: pendingFetchAbortController.signal,
            });
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                if (agentStopped) throw new AgentStoppedError();
                if (agentPaused) throw new AgentPausedError();
            }
            console.error("Completion check failed:", error);
            return null;
        } finally {
            pendingFetchAbortController = null;
        }
        throwIfStopped();
        if (!response.ok) {
            console.error(`Completion check endpoint error ${response.status}:`, await response.text());
            return null;
        }
        try {
            const data = await response.json();
            const reply = typeof data.reply === "string" ? data.reply : JSON.stringify(data.reply);
            const parsed = JSON.parse(reply);
            return typeof parsed?.complete === "boolean" ? parsed : null;
        } catch (e) {
            console.error("Failed to parse completion check reply:", e);
            return null;
        }
    }

    async function buildTaskPlan(instruction: string): Promise<AgentTaskPlan> {
        const plannerResult = await planTask(instruction);
        if (!plannerResult) {
            throw new Error("Planner failed to generate a plan.");
        }

        console.log("Planner result:", plannerResult);
        applyNotesEdits(plannerResult.notes_edits, "planner");

        if (plannerResult.complexity === "complex") {
            console.log("Planner determined the task is complex.");
            const tasks = plannerResult.tasks;
            if (!tasks || tasks.length === 0) {
                throw new Error("Planner marked task as complex but did not return any subtasks.");
            }

            return {
                complexity: plannerResult.complexity,
                tasks,
            };
        }

        return {
            complexity: plannerResult.complexity,
            tasks: [instruction],
        };
    }


    /**
     * The agent's notepad: short-term memory it writes and reads through the
     * write_notes / read_notes tools. It lasts for the whole run, across macro
     * tasks (which otherwise share no memory).
     */
    let agentNotes = "";
    /** Set by read_notes so the next agent call gets the whole notepad even when it's too long to inline. */
    let showFullNotesNextCall = false;
    /** Notes up to this size are sent with every agent call; past it, only the most recent part is (all of it after read_notes). */
    const NOTES_INLINE_LIMIT = 4000;
    const NOTES_MAX_LENGTH = 20000;

    function notesContext(): string {
        if (!agentNotes) {
            return "\n\nYour notepad (short-term memory): empty. Use write_notes to save anything you'll need later.";
        }
        const header = "\n\n=== YOUR NOTEPAD (short-term memory, written by you earlier in this task) ===\n";
        const footer = "\n=== END OF NOTEPAD ===";
        if (agentNotes.length <= NOTES_INLINE_LIMIT || showFullNotesNextCall) {
            return `${header}${agentNotes}${footer}`;
        }
        // Too long to send whole: show the most recent part of the log, cut at a line boundary.
        let tail = agentNotes.slice(-NOTES_INLINE_LIMIT);
        const firstBreak = tail.indexOf("\n");
        if (firstBreak !== -1 && firstBreak < tail.length - 1) tail = tail.slice(firstBreak + 1);
        const hidden = agentNotes.length - tail.length;
        return `${header}[${hidden} characters of older notes hidden — call read_notes to see everything, or tidy up with write_notes mode "replace"]\n${tail}${footer}`;
    }

    /** Tip topics the agent asked for with get_tips; they stay on for the rest of the run. */
    const requestedTips = new Set<string>();
    /** Tip the decision model picked for the current situation; null if it picked none or couldn't be reached. */
    let autoTipId: string | null = null;
    /** Tips included in the previous step, so the UI is told only when a tip newly arrives. */
    let tipsSentLastStep = new Set<string>();
    let lastDecisionHost: string | undefined;
    let stepsSinceDecision = Infinity;
    /** How often the decision model is asked again on the same site (it is always asked again when the site changes). */
    const TIP_DECISION_EVERY_STEPS = 4;

    /**
     * Asks the backend's decision model (Jev, via the dispatcher role) whether one of the tips fits
     * the current situation. Runs when the site changes and every few steps after that; never throws,
     * and a failure just means no automatic tip.
     */
    async function decideAutoTip(userPrompt: string, currentUrl?: string): Promise<void> {
        if (taskTips.length === 0) return;
        let host: string | undefined;
        try { host = currentUrl ? new URL(currentUrl).hostname : undefined; } catch { /* not a URL */ }
        stepsSinceDecision++;
        if (host === lastDecisionHost && stepsSinceDecision < TIP_DECISION_EVERY_STEPS) return;
        lastDecisionHost = host;
        stepsSinceDecision = 0;
        try {
            const response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    agentRole: "dispatcher",
                    state: {
                        task: userPrompt,
                        current_url: currentUrl ?? "",
                        recent_actions: past_actions.slice(-5).map(a => `${a.tool}: ${a.explanation ?? ""}${a.result ? ` (${a.result})` : ""}`),
                        agent_notepad: agentNotes.slice(-1500),
                    },
                    questions: {
                        tip: {
                            type: "choice",
                            instructions: "A browser agent is working on the task described in the state. Choose the one tip that would clearly help it with what it is doing or stuck on right now, or none if no tip clearly applies. Prefer none over a tip that is only loosely related.",
                            criteria: {
                                none: "No tip clearly applies to the current situation.",
                                ...Object.fromEntries(taskTips.map(t => [t.id, t.description])),
                            },
                        },
                    },
                }),
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) throw new Error(`dispatcher returned ${response.status}`);
            const choice = (await response.json())?.answers?.tip?.choice;
            autoTipId = taskTips.some(t => t.id === choice) ? choice : null;
            console.log(`[Agent] tip decision: ${autoTipId ?? "none"}`);
        } catch (error) {
            console.warn("[Agent] tip decision failed:", error);
            autoTipId = null;
        }
    }

    /**
     * Task-specific tips for this step: the one the decision model picked, plus any the agent
     * asked for by name. Automatic ones are labelled as such. Tips not shown yet are listed by id
     * and description, so the agent can request one with get_tips.
     */
    function tipsContext(): string {
        const requested = taskTips.filter(tip => requestedTips.has(tip.id));
        const automatic = taskTips.filter(tip => !requestedTips.has(tip.id) && tip.id === autoTipId);
        const available = taskTips.filter(tip => !requested.includes(tip) && !automatic.includes(tip));
        // Tell the UI about a tip the first time it's sent (and again if it was dropped and comes back).
        const sentNow = new Map<string, boolean>([...requested.map(t => [t.id, false] as const), ...automatic.map(t => [t.id, true] as const)]);
        for (const [id, auto] of sentNow) {
            if (!tipsSentLastStep.has(id)) {
                const tip = taskTips.find(t => t.id === id)!;
                emit("agent:tip", { id, auto, description: tip.description, text: tip.text });
            }
        }
        tipsSentLastStep = new Set(sentNow.keys());
        let out = "";
        if (requested.length > 0) out += `\n\n=== TIPS YOU ASKED FOR ===\n${requested.map(t => t.text).join("\n\n")}\n=== END OF TIPS ===`;
        if (automatic.length > 0) {
            out += `\n\n=== AUTOMATICALLY ADDED TIP — a helper picked this for you; you did not ask for it, and it may or may not be useful. Use it only if it fits what you are doing, otherwise ignore it. ===\n${automatic.map(t => t.text).join("\n\n")}\n=== END OF TIP ===`;
        }
        if (available.length > 0) {
            out += `\n\nMore tips are available — call get_tips with the topic if one fits what you're stuck on:\n${available.map(t => `- ${t.id}: ${t.description}`).join("\n")}`;
        }
        return out;
    }

    /** get_tips tool: turn on a tip topic by id (or list the topics). Returns the result shown to the model. */
    function applyGetTips(topic: string): string {
        const tip = taskTips.find(t => t.id === topic.trim().toLowerCase());
        if (!tip) return `no tip topic "${topic}". Available: ${taskTips.map(t => t.id).join(", ")}`;
        requestedTips.add(tip.id);
        return `tip "${tip.id}" is included in your next steps`;
    }

    /**
     * The model sometimes writes final_answer as JSON despite being told not to.
     * Turn such an answer into readable Markdown; leave anything else untouched.
     */
    function humanizeFinalAnswer(answer: string): string {
        const trimmed = answer.trim();
        if (!/^[[{]/.test(trimmed)) return answer;
        let data: unknown;
        try {
            data = JSON.parse(trimmed);
        } catch {
            return answer;
        }
        if (data === null || typeof data !== "object") return answer;

        const label = (key: string) => {
            const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
            return words.charAt(0).toUpperCase() + words.slice(1);
        };
        const inline = (value: unknown): string => {
            if (value === null || value === undefined) return "—";
            if (typeof value === "boolean") return value ? "Yes" : "No";
            if (Array.isArray(value)) return value.map(inline).join(", ");
            if (typeof value === "object") {
                return Object.entries(value as Record<string, unknown>)
                    .map(([k, v]) => `${label(k)}: ${inline(v)}`)
                    .join(" · ");
            }
            return String(value);
        };
        const block = (value: unknown): string => {
            if (Array.isArray(value)) return value.map(item => `- ${inline(item)}`).join("\n");
            if (value && typeof value === "object") {
                return Object.entries(value as Record<string, unknown>)
                    .map(([k, v]) => (v && typeof v === "object")
                        ? `**${label(k)}:**\n${block(v)}`
                        : `**${label(k)}:** ${inline(v)}`)
                    .join("\n\n");
            }
            return inline(value);
        };
        return block(data);
    }

    /** Updates the notepad and mirrors it to the UI's live notepad panel. */
    function setAgentNotes(notes: string): void {
        agentNotes = notes;
        emit("agent:notes", agentNotes);
    }

    /** Applies a write_notes / read_notes command and returns the result shown to the model in past actions. */
    function applyNotesCommand(cmd: { type: string; text?: string; mode?: string; find?: string }): string {
        if (cmd.type === "agent:read_notes") {
            showFullNotesNextCall = true;
            return agentNotes ? `the full notepad (${agentNotes.length} chars) is included in the next step` : "notepad is empty";
        }
        const text = cmd.text ?? "";
        let next: string;
        if (cmd.mode === "edit") {
            // Overwrite one exact passage. It must match exactly once, so the agent
            // never changes a part of its notes it didn't mean to.
            const find = cmd.find ?? "";
            if (!find) return `failed: mode "edit" needs \`find\` (the exact text in your notepad to overwrite).`;
            const count = agentNotes.split(find).length - 1;
            if (count === 0) {
                return `failed: \`find\` text not found in your notepad. Copy it exactly from YOUR NOTEPAD${agentNotes.length > NOTES_INLINE_LIMIT ? " (older notes are hidden — read_notes shows them)" : ""}.`;
            }
            if (count > 1) return `failed: \`find\` text appears ${count} times in your notepad. Include more of the surrounding text so it's unique.`;
            const at = agentNotes.indexOf(find);
            const before = agentNotes.slice(0, at);
            let after = agentNotes.slice(at + find.length);
            // Deleting a whole line shouldn't leave an empty one behind where it was.
            if (!text && after.startsWith("\n") && (before === "" || before.endsWith("\n"))) after = after.slice(1);
            next = before + text + after;
            if (!text && !after && next.endsWith("\n")) next = next.slice(0, -1);
        } else if (cmd.mode === "replace") {
            next = text;
        } else {
            next = agentNotes ? `${agentNotes}\n${text}` : text;
        }
        if (next.length > NOTES_MAX_LENGTH) {
            return `failed: notepad would exceed ${NOTES_MAX_LENGTH} chars. Use mode "replace" with a shorter summary.`;
        }
        setAgentNotes(next);
        return cmd.mode === "edit"
            ? `edited; notepad is now ${agentNotes.length} chars`
            : `saved; notepad is now ${agentNotes.length} chars`;
    }

    const PLAN_HEADER = "PLAN (steps are ticked off as they're finished):";

    /**
     * Writes a new plan checklist into the notepad. A new plan covers everything still left
     * (the planner sees the old one), so it takes the place of any earlier PLAN: the earlier
     * unfinished steps are dropped and only its finished ones are kept, as a record of what's done.
     */
    function writePlanToNotes(tasks: string[]): void {
        const planText = `${PLAN_HEADER}\n${tasks.map((t, i) => `[ ] ${i + 1}. ${t}`).join("\n")}`;
        const kept: string[] = [];
        let insertAt = -1;
        let inPlan = false;
        for (const line of agentNotes.split("\n")) {
            if (line.trim().startsWith("PLAN (")) {
                if (insertAt === -1) insertAt = kept.length;
                inPlan = true;
                continue;
            }
            // Old checklist lines go, wherever they ended up; finished ones are kept as plain history.
            const step = line.match(/^\s*\[([ x\-])\]\s*\d+\.\s*(.*)$/i);
            if (inPlan && step) {
                if (step[1].toLowerCase() === "x") kept.push(`Done earlier: ${step[2]}`);
                continue;
            }
            if (inPlan && !line.trim()) continue;
            kept.push(line);
        }
        if (insertAt === -1) {
            applyNotesCommand({ type: "agent:write_notes", mode: "append", text: planText });
            return;
        }
        kept.splice(insertAt, 0, planText);
        applyNotesCommand({ type: "agent:write_notes", mode: "replace", text: kept.join("\n").trim() });
    }

    /**
     * Applies the `notes_edits` the planner or supervisor returned, so they can fix the agent's
     * notepad too (tick off steps, correct a wrong fact, drop a stale plan). Each edit is
     * { mode: "append" | "edit" | "replace", text, find? }; appended lines are tagged with who wrote them.
     */
    function applyNotesEdits(edits: unknown, source: "planner" | "supervisor"): void {
        if (!Array.isArray(edits)) return;
        for (const edit of edits) {
            if (!edit || typeof edit !== "object") continue;
            const { mode, text, find } = edit as { mode?: unknown; text?: unknown; find?: unknown };
            const safeMode = mode === "edit" || mode === "replace" ? mode : "append";
            const safeText = typeof text === "string" ? text : "";
            if (safeMode === "append" && !safeText.trim()) continue;
            const result = applyNotesCommand({
                type: "agent:write_notes",
                mode: safeMode,
                text: safeMode === "append" ? `(${source}) ${safeText}` : safeText,
                find: typeof find === "string" ? find : undefined,
            });
            console.log(`[Agent] ${source} notepad ${safeMode}: ${result}`);
        }
    }

    type ScrollPosition = { y: number; viewport: number; height: number; inner: boolean };

    /**
     * Where the page is scrolled to, so the agent knows what it has already seen.
     * Uses the document, or for app-style pages that keep the document fixed, the
     * largest scrollable container.
     */
    async function getScrollPosition(wc: Electron.WebContents): Promise<ScrollPosition | undefined> {
        return runInMainFrame<ScrollPosition>(wc, `
            (() => {
                const root = document.scrollingElement || document.documentElement;
                const pos = { y: root.scrollTop, viewport: window.innerHeight, height: root.scrollHeight, inner: false };
                if (pos.height > pos.viewport + 2) return pos;
                let best = null, bestArea = 0;
                for (const el of document.querySelectorAll('body *')) {
                    if (el.scrollHeight <= el.clientHeight + 2 || el.clientHeight < 100) continue;
                    const overflow = getComputedStyle(el).overflowY;
                    if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') continue;
                    const area = el.clientWidth * el.clientHeight;
                    if (area > bestArea) { best = el; bestArea = area; }
                }
                if (best && bestArea > window.innerWidth * window.innerHeight * 0.3) {
                    return { y: best.scrollTop, viewport: best.clientHeight, height: best.scrollHeight, inner: true };
                }
                return pos;
            })()
        `, 2000);
    }

    function describeScrollPosition(p: ScrollPosition): string {
        const top = Math.round(p.y);
        const bottom = Math.round(p.y + p.viewport);
        const total = Math.round(p.height);
        const area = p.inner ? "main scroll area" : "page";
        if (total <= p.viewport + 2) return `the whole ${area} fits on screen (nothing to scroll)`;
        const where = top <= 2 ? "at the top"
            : bottom >= total - 2 ? "at the bottom"
            : `${Math.round((bottom / total) * 100)}% of the way down`;
        return `${area} showing ${top}–${bottom}px of ${total}px (${where})`;
    }

    /** Past-action result for a scroll or scrolling keypress: where it ended up, or that nothing moved. */
    function describeScrollChange(before: ScrollPosition, after: ScrollPosition, targetedElement: boolean): string {
        if (Math.abs(after.y - before.y) < 2) {
            return targetedElement
                ? `${after.inner ? "main scroll area" : "page"} did not move (the targeted element may have scrolled instead); still ${describeScrollPosition(after)}`
                : `did not move; still ${describeScrollPosition(after)}`;
        }
        return `now ${describeScrollPosition(after)}`;
    }

    async function GetAction(userPrompt:string, imageurl:string, currentUrl?: string, openTabs?: AgentTabInfo[], elements?: LabeledElement[], scrollPosition?: ScrollPosition, overallRequest?: string, screenNote?: string){
        throwIfStopped();
        const tabsContext = openTabs && openTabs.length > 0
            ? `\nOpen tabs:\n${openTabs.map((t, i) => `  ${t.isAgentTab ? '[your tab] ' : ''}Tab ${i + 1}: ${t.title || 'Untitled'} — ${t.url}`).join('\n')}`
            : "";
        // A sub-task (or a supervisor's refined prompt) on its own loses the conversation it came from.
        const overallContext = overallRequest
            ? `\n\nOverall request this is part of (including the conversation so far):\n${overallRequest}\n`
            : "";
        const scrollContext = scrollPosition ? `\nScroll position: ${describeScrollPosition(scrollPosition)}` : "";
        const screenContext = screenNote ? `\nNote: ${screenNote}` : "";
        const elementsContext = elements
            ? `\nInteractive elements on screen (label, element):\n${formatElementList(elements)}`
            : "";
        await decideAutoTip(userPrompt, currentUrl);
        throwIfStopped();
        pendingFetchAbortController = new AbortController();
        let response: Response;
        try {
            response = await fetch("https://indus-backend.tushar-vijayanagar.workers.dev/agent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ 
                    messages: [
                        // The static prompt is cached by the backend (prompt caching); anything that
                        // changes per step must come after it, or every step pays for the full prompt.
                        { role: "system", content: agentPrompt, cache: true },
                        ...(past_actions.length > 0
                            ? [{ role: "system", content: "Previous actions taken so far:\n" + past_actions.slice(-20).map((a, i) => `${i + 1}. ${JSON.stringify(a)}`).join("\n") }]
                            : []),
                        { role: "user", content: `User task: "${userPrompt}"${overallContext}${currentUrl ? `\nCurrent URL: ${currentUrl}` : ""}${screenContext}${scrollContext}${tabsContext}${elementsContext}${notesContext()}${tipsContext()}` }
                    ],
                    ...(imageurl ? { imageUrl: imageurl } : {}),
                    // The backend's default tools are label-based; grid mode overrides them.
                    ...(TARGETING_MODE === "grid" ? { tools: GRID_MODE_TOOLS } : {}),
                }),
                signal: pendingFetchAbortController.signal,
            });
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                if (agentStopped) throw new AgentStoppedError();
                if (agentPaused) throw new AgentPausedError();
            }
            throw error;
        } finally {
            pendingFetchAbortController = null;
        }

        throwIfStopped();
        if (!response.ok) {
            const errText = await response.text();
            console.error(`Agent endpoint error ${response.status}:`, errText);
            throw new Error(`Agent action endpoint returned ${response.status}: ${errText}`);
        }
        const data = await response.json();
        return data;
    }

    /** Reverse of gridLabel(): parse e.g. "a5" → 0-based grid index.
     * Each letter covers 10 raw indices (a→0-9, b→10-19, …).
     * Number 1-10 maps to offset 0-9 within the group. */
    function parseLabelIndex(label: string): number {
        const letters = "abcdefghijklmnopqrstuvwxyz";
        const match = label.toLowerCase().match(/^([a-z])(\d+)$/);
        if (!match) throw new Error(`Invalid grid label: "${label}"`);
        const letterIdx = letters.indexOf(match[1]);  // 0-based letter group
        const num       = parseInt(match[2], 10);     // 1-based number within group
        return letterIdx * 10 + (num - 1);            // 0-based raw grid index
    }

    function toNumberIfFinite(value: unknown): number | null {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed)) return parsed;
        }
        return null;
    }

    function resolveScreenshotPointFromToolArgs(
        xArg: unknown,
        yArg: unknown,
        screenshotW: number,
        screenshotH: number
    ): { x: number; y: number } {
        const numericX = toNumberIfFinite(xArg);
        const numericY = toNumberIfFinite(yArg);

        // If the model returns numeric coordinates, treat them as screenshot-space pixels.
        if (numericX !== null && numericY !== null) {
            return {
                x: Math.max(0, Math.min(Math.round(numericX), screenshotW - 1)),
                y: Math.max(0, Math.min(Math.round(numericY), screenshotH - 1)),
            };
        }

        if (typeof xArg === "string" && typeof yArg === "string") {
            return translateCoordinates(xArg, yArg, screenshotW, screenshotH);
        }

        throw new Error(
            `Invalid coordinates from model. Expected grid labels or numeric x/y, got x=${JSON.stringify(xArg)}, y=${JSON.stringify(yArg)}`
        );
    }

    /**
     * Convert a column label + row label (e.g. "2c", "3a") into pixel
     * coordinates within the original screenshot (W × H).
     *
     * Grid spacing: colStep = W * 0.015,  rowStep = H * 0.015
     * (mirrors screenshotProcessor.ts)
     */
    function translateCoordinates(
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

    type ActiveSurface = {
        wc: Electron.WebContents;
        x: number;
        y: number;
        w: number;
        h: number;
        kind: "webview" | "renderer";
        /** On screen, so native input reaches it. Otherwise the agent uses backgroundInput. */
        foreground: boolean;
    };

    /** What the UI says about the agent's own tab. */
    async function getAgentSurfaceInfo(): Promise<Exclude<AgentTabSurface, { mode: "closed" }> | null> {
        const info = await tabs.surface().catch(() => null);
        if (info?.mode === "closed") throw new AgentTabClosedError();
        return info;
    }

    /** The agent's own tab: its guest WebContents (or the on-screen New Tab page) and bounds in window space. */
    async function getAgentSurface(): Promise<ActiveSurface | null> {
        const info = await getAgentSurfaceInfo();
        if (!info || info.mode === "internal") return null;

        if (info.mode === "renderer") {
            const win = getMainWindow();
            if (!win) return null;
            return { wc: win.webContents, x: info.x, y: info.y, w: info.w, h: info.h, kind: "renderer", foreground: true };
        }

        if (!info.wcId) {
            // Can happen briefly while a new tab/webview is being attached.
            console.warn("Agent's webview exists but its guest WebContents is not ready yet");
            return null;
        }
        const guestWc = allWebContents.fromId(info.wcId);
        if (!guestWc || guestWc.isDestroyed()) {
            console.error("Could not find the agent's webview WebContents");
            return null;
        }
        return { wc: guestWc, x: info.x, y: info.y, w: info.w, h: info.h, kind: "webview", foreground: info.visible };
    }

    type ScreenshotResult = {
        base64: string;
        w: number;
        h: number;
        winW: number;
        winH: number;
        elements: LabeledElement[];
        /** Told to the model when there's no (useful) screenshot this step. */
        note?: string;
    };

    async function takeScreenshot(): Promise<ScreenshotResult | null> {
        // Capture only the webview content so all coordinates are webview-relative.
        const MAX_RETRIES = 8;
        const RETRY_DELAY_MS = 750;
        const CAPTURE_TIMEOUT_MS = 3000;

        let webviewInfo: ActiveSurface | null = null;
        let image: Electron.NativeImage | null = null;
        let elements: LabeledElement[] = [];
        // Size of the space element boxes are positioned in (see ExtractionResult).
        let labelSurface: { w: number; h: number } | null = null;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                await new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
            const info = await getAgentSurfaceInfo();
            if (info?.mode === "internal") {
                currentLabels = new Map();
                return {
                    base64: "", w: 0, h: 0, winW: 0, winH: 0, elements: [],
                    note: `Your tab is showing a browser page (${info.url}) that you can't see or use. Use navigate to open a website in it.`,
                };
            }
            webviewInfo = await getAgentSurface();
            if (!webviewInfo) {
                console.warn(`takeScreenshot: no agent surface (attempt ${attempt + 1}/${MAX_RETRIES})`);
                continue;
            }
            if (TARGETING_MODE === "labels") {
                // Extract right before capturing so element boxes match the frame.
                const region = webviewInfo.kind === "renderer"
                    ? { x: webviewInfo.x, y: webviewInfo.y, w: webviewInfo.w, h: webviewInfo.h }
                    : null;
                const extraction = await extractInteractiveElements(webviewInfo.wc, region);
                elements = extraction.elements;
                currentLabels = extraction.labels;
                labelSurface = { w: extraction.surfaceW, h: extraction.surfaceH };
            }
            // capturePage waits for a frame, and a tab that isn't on screen may never produce
            // one — so never wait on it indefinitely.
            const capture = webviewInfo.kind === "renderer"
                ? webviewInfo.wc.capturePage({
                    x: Math.round(webviewInfo.x),
                    y: Math.round(webviewInfo.y),
                    width: Math.max(1, Math.round(webviewInfo.w)),
                    height: Math.max(1, Math.round(webviewInfo.h)),
                })
                : webviewInfo.wc.capturePage();
            let captureTimer: NodeJS.Timeout | undefined;
            image = await Promise.race([
                capture.catch(() => null),
                new Promise<null>(resolve => { captureTimer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS); }),
            ]);
            clearTimeout(captureTimer);
            const imageSize = image?.getSize();
            if (image && imageSize && imageSize.width > 0 && imageSize.height > 0) {
                break; // Got a valid frame
            }
            image = null;
            // A tab that isn't on screen may not produce frames. Rather than stall, work
            // from the element list (which doesn't need a frame) for this step.
            if (!webviewInfo.foreground && TARGETING_MODE === "labels" && labelSurface && labelSurface.w > 0) {
                console.warn("takeScreenshot: background tab produced no frame; continuing without a screenshot");
                return {
                    base64: "", w: 0, h: 0,
                    winW: Math.round(labelSurface.w), winH: Math.round(labelSurface.h),
                    elements,
                    note: "No screenshot this step (your tab is in the background). Work from the element list, the scroll position and your notes.",
                };
            }
            console.warn(`takeScreenshot: capturePage returned an empty image, retrying... (attempt ${attempt + 1}/${MAX_RETRIES})`);
        }

        if (!webviewInfo || !image) {
            console.error("takeScreenshot: could not capture a valid screenshot after retries");
            return null;
        }

        // In label mode, use the guest's own size rather than the <webview> element's
        // on-screen box, which a pinch-zoom CSS transform scales.
        const winW = Math.round(labelSurface?.w ?? webviewInfo.w);
        const winH = Math.round(labelSurface?.h ?? webviewInfo.h);
        const resized = image.resize({ width: 1200 });
        const w = resized.getSize().width;
        const h = resized.getSize().height;
        const rawBase64 = resized.toDataURL();
        if (!rawBase64 || rawBase64 === "data:,") {
            console.error("takeScreenshot: toDataURL returned empty string");
            return null;
        }
        let processedBase64: string;
        if (TARGETING_MODE === "labels") {
            processedBase64 = await drawElementLabels(rawBase64, elements, w / winW, lastCursorPos);
        } else {
            // Scale last click position from webview CSS pixels to resized-screenshot pixels.
            const cursorInShot = lastCursorPos
                ? { x: Math.round(lastCursorPos.x * (w / winW)), y: Math.round(lastCursorPos.y * (h / winH)) }
                : undefined;
            processedBase64 = await processScreenshotForAgent(rawBase64, cursorInShot);
        }

        // Save to disk for inspection
        const savePath = join(tmpdir(), "indus-agent-screenshot.jpg");
        const imgData = processedBase64.replace(/^data:image\/\w+;base64,/, "");
        writeFileSync(savePath, Buffer.from(imgData, "base64"));

        return { base64: processedBase64, w, h, winW, winH, elements };
    }


    async function snapToNearestClickablePoint(
        /**
        * Finds the most likely clickable target near (targetX, targetY) in the webview.
        *
        * The search prefers elements that are actually topmost under the pointer (via
        * `elementsFromPoint`) instead of only matching a static selector list. This makes
        * tiny controls such as popup close buttons more reliable, even when the clickable
        * semantics live on an ancestor or are expressed through cursor/ARIA heuristics.
        * Returns a point inside the resolved clickable target, or the original coords if
        * no better target is found within MAX_RADIUS CSS pixels.
        */

        wc: Electron.WebContents,
        targetX: number,
        targetY: number,
        maxRadius = 180
    ): Promise<{ x: number; y: number }> {
        const result = await wc.executeJavaScript(`
            (() => {
                const targetX = ${targetX};
                const targetY = ${targetY};
                const maxRadius = ${maxRadius};

                const CLICKABLE_TAGS = new Set([
                    'a', 'button', 'input', 'select', 'textarea', 'summary',
                    'label', 'option', 'details'
                ]);
                const INTERACTIVE_ROLES = new Set([
                    'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
                    'tab', 'checkbox', 'radio', 'option', 'switch'
                ]);
                const CLOSE_KEYWORDS = /(^|[^a-z])(close|dismiss|cancel|remove|delete|clear|exit|x)([^a-z]|$)/i;

                const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
                const roundPoint = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
                const inViewport = (x, y) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;

                const getParentElement = (el) => {
                    if (!el || !(el instanceof Element)) return null;
                    if (el.parentElement) return el.parentElement;
                    const root = el.getRootNode?.();
                    if (root instanceof ShadowRoot && root.host instanceof Element) return root.host;
                    return null;
                };

                const isVisible = (el) => {
                    if (!el || !(el instanceof Element)) return false;
                    let current = el;
                    while (current) {
                        const style = window.getComputedStyle(current);
                        if (
                            style.display === 'none' ||
                            style.visibility === 'hidden' ||
                            style.pointerEvents === 'none' ||
                            style.opacity === '0'
                        ) {
                            return false;
                        }
                        current = getParentElement(current);
                    }
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return false;
                    return rect.bottom > 0 && rect.right > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
                };

                const isDisabled = (el) => {
                    if (!(el instanceof Element)) return false;
                    return el.matches(':disabled,[aria-disabled="true"]');
                };

                const hasCloseLikeSemantics = (el) => {
                    if (!(el instanceof Element)) return false;
                    const text = [
                        el.getAttribute('aria-label'),
                        el.getAttribute('title'),
                        el.getAttribute('name'),
                        el.getAttribute('alt'),
                        el.getAttribute('data-testid'),
                        el.getAttribute('data-test'),
                        el.id,
                        typeof el.className === 'string' ? el.className : '',
                    ].filter(Boolean).join(' ');
                    return CLOSE_KEYWORDS.test(text);
                };

                const isClickableCandidate = (el) => {
                    if (!el || !(el instanceof Element) || !isVisible(el) || isDisabled(el)) return false;

                    const tag = el.tagName.toLowerCase();
                    const role = (el.getAttribute('role') || '').toLowerCase();
                    const type = (el.getAttribute('type') || '').toLowerCase();
                    const tabIndex = el.getAttribute('tabindex');
                    const style = window.getComputedStyle(el);

                    if (tag === 'input' && type === 'hidden') return false;
                    if (CLICKABLE_TAGS.has(tag)) return true;
                    if (INTERACTIVE_ROLES.has(role)) return true;
                    if (el.hasAttribute('href') || (tag === 'a' && !!el.getAttribute('href'))) return true;
                    if (el.hasAttribute('onclick') || typeof el.onclick === 'function') return true;
                    if (tabIndex !== null && tabIndex !== '-1') return true;
                    if (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true') return true;
                    if (style.cursor === 'pointer') return true;
                    if (hasCloseLikeSemantics(el)) return true;

                    return false;
                };

                const resolveClickableTarget = (startEl) => {
                    let current = startEl;
                    let hops = 0;
                    while (current && hops < 8) {
                        if (isClickableCandidate(current)) return { el: current, hops };
                        current = getParentElement(current);
                        hops += 1;
                    }
                    return null;
                };

                const pointInsideRect = (rect, preferredX, preferredY) => {
                    const minX = rect.width <= 2 ? (rect.left + rect.right) / 2 : rect.left + 1;
                    const maxX = rect.width <= 2 ? (rect.left + rect.right) / 2 : rect.right - 1;
                    const minY = rect.height <= 2 ? (rect.top + rect.bottom) / 2 : rect.top + 1;
                    const maxY = rect.height <= 2 ? (rect.top + rect.bottom) / 2 : rect.bottom - 1;
                    return roundPoint(clamp(preferredX, minX, maxX), clamp(preferredY, minY, maxY));
                };

                let best = null;
                let bestScore = Infinity;

                const considerPoint = (sampleX, sampleY, scanRadius) => {
                    if (!inViewport(sampleX, sampleY)) return;

                    const stack = document.elementsFromPoint(sampleX, sampleY);
                    const seen = new Set();

                    for (let stackIndex = 0; stackIndex < stack.length; stackIndex += 1) {
                        const resolved = resolveClickableTarget(stack[stackIndex]);
                        if (!resolved) continue;

                        const { el, hops } = resolved;
                        if (seen.has(el)) continue;
                        seen.add(el);

                        const rect = el.getBoundingClientRect();
                        const clickPoint = pointInsideRect(rect, sampleX, sampleY);
                        const distToTarget = Math.hypot(clickPoint.x - targetX, clickPoint.y - targetY);
                        if (distToTarget > maxRadius) continue;

                        const area = Math.max(1, rect.width * rect.height);
                        const score =
                            distToTarget * 100 +
                            scanRadius * 10 +
                            stackIndex * 6 +
                            hops * 3 +
                            Math.min(12, Math.log(area + 1));

                        if (score >= bestScore) continue;
                        bestScore = score;
                        best = clickPoint;

                        if (distToTarget === 0 && stackIndex === 0 && hops === 0) {
                            return true;
                        }
                    }

                    return false;
                };

                if (considerPoint(Math.round(targetX), Math.round(targetY), 0)) {
                    return best;
                }

                for (let radius = 6; radius <= maxRadius; radius += 6) {
                    const steps = Math.max(8, Math.ceil((Math.PI * 2 * radius) / 10));
                    for (let step = 0; step < steps; step += 1) {
                        const angle = (step / steps) * Math.PI * 2;
                        const sampleX = Math.round(targetX + Math.cos(angle) * radius);
                        const sampleY = Math.round(targetY + Math.sin(angle) * radius);
                        if (considerPoint(sampleX, sampleY, radius)) {
                            return best;
                        }
                    }
                }

                return best || roundPoint(targetX, targetY);
            })()
        `).catch(() => null);

        if (result && typeof result.x === "number" && typeof result.y === "number") {
            return { x: result.x, y: result.y };
        }
        return { x: targetX, y: targetY };
    }

    async function executeCommand(cmd: any): Promise<void> {
        throwIfStopped();

        if (cmd.type === "agent:new-tab") {
            await tabs.openTab(cmd.url || "about:blank");
        } else if (cmd.type === "agent:click") {
            const webviewInfo = await getAgentSurface();
            if (!webviewInfo) {
                console.error("Cannot click: no active interaction surface found");
                return;
            }
            const isRendererSurface = webviewInfo.kind === "renderer";
            let relX: number;
            let relY: number;
            let resolved: ResolvedLabelPoint | null = null;
            if (cmd.label !== undefined) {
                // Label clicks already target a hit-tested point inside the element; re-resolve
                // it in case the layout shifted since the screenshot, otherwise use the stored point.
                resolved = await resolveLabeledElementPoint(currentLabels, cmd.label);
                relX = resolved?.x ?? cmd.x;
                relY = resolved?.y ?? cmd.y;
            } else {
                const targetXInWc = isRendererSurface ? Math.round(webviewInfo.x + cmd.x) : cmd.x;
                const targetYInWc = isRendererSurface ? Math.round(webviewInfo.y + cmd.y) : cmd.y;
                const snappedPoint = await snapToNearestClickablePoint(webviewInfo.wc, targetXInWc, targetYInWc);
                relX = isRendererSurface ? Math.round(snappedPoint.x - webviewInfo.x) : snappedPoint.x;
                relY = isRendererSurface ? Math.round(snappedPoint.y - webviewInfo.y) : snappedPoint.y;
            }
            lastCursorPos = { x: relX, y: relY };
            const clickCount = Math.max(1, Math.min(3, Math.round(Number(cmd.clickCount) || 1)));

            // Clicks the interactive element at (x, y) — page CSS pixels — from JavaScript: walks up to the
            // nearest <a>/<button>/interactive ancestor, which covers handlers delegated to a container.
            const jsClickAt = (x: number, y: number) => webviewInfo.wc.executeJavaScript(`
                (function() {
                    const CLICKABLE_TAGS = new Set(['a','button','input','select','textarea','label']);
                    let el = document.elementFromPoint(${x}, ${y});
                    while (el && el !== document.documentElement && el !== document.body) {
                        const tag = el.tagName.toLowerCase();
                        const role = (el.getAttribute('role') || '').toLowerCase();
                        if (CLICKABLE_TAGS.has(tag) || el.hasAttribute('onclick') ||
                            role === 'button' || role === 'link' || role === 'menuitem' ||
                            role === 'tab' || role === 'option' || role === 'checkbox') {
                            el.click();
                            return;
                        }
                        el = el.parentElement;
                    }
                    // Nothing semantic found — click whatever is directly at the point.
                    const leaf = document.elementFromPoint(${x}, ${y});
                    if (leaf) leaf.click();
                })()
            `).catch(() => {});

            if (!webviewInfo.foreground) {
                // Background tab: native input can't reach it, so click from JavaScript. Never
                // focus it either — that would pull keyboard focus away from what the user is doing.
                if (cmd.label !== undefined) {
                    for (let i = 0; i < clickCount; i++) {
                        if (i > 0) await resolveLabeledElementPoint(currentLabels, cmd.label); // re-arm the click probe
                        await confirmLabeledClick(currentLabels, cmd.label);
                    }
                } else {
                    const zoom = webviewInfo.wc.getZoomFactor() || 1;
                    await jsClickAt(Math.round(relX / zoom), Math.round(relY / zoom));
                }
                return;
            }

            getMainWindow()?.focus();
            webviewInfo.wc.focus();

            // sendInputEvent on the TOP-LEVEL window's webContents expects PHYSICAL pixels,
            // not CSS/logical pixels, on Windows with display scaling > 100% (this is the
            // "renderer" surface case, e.g. clicking the new-tab page). Guest <webview>
            // WebContents, however, interpret sendInputEvent coordinates in the webview's own
            // (unzoomed) pixel space — scaling those by the display factor sends the native
            // event to the wrong on-screen pixel. Note that's only the guest page's CSS-pixel
            // space at zoom 100%.
            const toEventPoint = (rx: number, ry: number) => {
                const ex = isRendererSurface ? Math.round(webviewInfo.x + rx) : rx;
                const ey = isRendererSurface ? Math.round(webviewInfo.y + ry) : ry;
                if (!isRendererSurface) return { eventX: ex, eventY: ey, physX: ex, physY: ey };
                const winBounds = getMainWindow()?.getBounds();
                const display = winBounds
                    ? electronScreen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y })
                    : electronScreen.getPrimaryDisplay();
                const sf = display.scaleFactor ?? 1;
                return { eventX: ex, eventY: ey, physX: Math.round(ex * sf), physY: Math.round(ey * sf) };
            };
            // Native input events — these are trusted (isTrusted=true) and work on
            // all sites including those that reject synthetic JS events.
            const nativeClick = async (px: number, py: number) => {
                webviewInfo.wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
                for (let i = 1; i <= clickCount; i++) {
                    webviewInfo.wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: i });
                    await sleepInterruptible(i === 1 && clickCount === 1 ? 80 : 40, 20);
                    webviewInfo.wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: i });
                }
            };
            const { eventX, eventY, physX, physY } = toEventPoint(relX, relY);

            if (cmd.label !== undefined) {
                // If the click doesn't visibly do anything, retry once dead centre — the
                // hit-tested point can land on an edge that looks like the control but isn't.
                const center = resolved && resolved.retryable &&
                    Math.hypot(resolved.centerX - relX, resolved.centerY - relY) > 3
                    ? { x: resolved.centerX, y: resolved.centerY } : null;
                let tabCountBefore = -1;
                let navigated = false;
                const onNavigate = () => { navigated = true; };
                if (center) {
                    await armPageChangeWatch(currentLabels, cmd.label);
                    tabCountBefore = (await tabs.listTabs().catch(() => [])).length;
                    webviewInfo.wc.on('did-start-navigation', onNavigate);
                }
                try {
                    await nativeClick(physX, physY);
                    // Give the renderer time to dispatch the trusted click, then JS-click the
                    // labelled element only if that click never reached it.
                    await sleepInterruptible(150, 50);
                    const landed = await confirmLabeledClick(currentLabels, cmd.label);
                    console.log(landed
                        ? `[Agent] Native click reached label ${cmd.label} at ${physX},${physY}.`
                        : `[Agent] Native click missed label ${cmd.label} at ${physX},${physY}; clicked it from JS instead.`);

                    if (center) {
                        // Network-backed actions (add to cart) usually show a spinner or
                        // disable the button right away, so 1s is plenty to see *something*.
                        const changed = navigated || await waitForPageChange(currentLabels, cmd.label, 1000) || navigated;
                        const tabOpened = !changed && (await tabs.listTabs().catch(() => [])).length !== tabCountBefore;
                        if (!changed && !tabOpened) {
                            const c = toEventPoint(center.x, center.y);
                            console.log(`[Agent] Click on label ${cmd.label} changed nothing; retrying at its centre ${c.physX},${c.physY}.`);
                            await nativeClick(c.physX, c.physY);
                            relX = center.x;
                            relY = center.y;
                            lastCursorPos = { x: relX, y: relY };
                        }
                    }
                } finally {
                    if (center) {
                        webviewInfo.wc.removeListener('did-start-navigation', onNavigate);
                        await stopPageChangeWatch(currentLabels, cmd.label);
                    }
                }
            } else {
                // JS fallback for React/SPA event-delegation cases where the handler lives on a
                // container rather than the leaf element. We do NOT send extra pointer/mouse
                // events here — duplicating them can cause double-actions.
                await jsClickAt(eventX, eventY);
            }

            emit("agent:cursor-flash", { x: Math.round(webviewInfo.x + relX), y: Math.round(webviewInfo.y + relY) });
        } else if (cmd.type === "agent:type") {
            const webviewInfo = await getAgentSurface();
            if (!webviewInfo) return;
            if (!webviewInfo.foreground) {
                await typeInBackground(webviewInfo.wc, cmd.text, throwIfStopped);
                if (cmd.pressEnter) {
                    await sleepInterruptible(150, 50);
                    await pressKeyInBackground(webviewInfo.wc, "Enter");
                }
                return;
            }
            // Ensure the webview has focus so keystrokes aren't silently dropped.
            getMainWindow()?.focus();
            webviewInfo.wc.focus();

            // Send each character as a full keyDown → insertText → keyUp sequence.
            // - keyDown/keyUp fire the keyboard events that game/canvas sites (e.g. Wordle)
            //   listen to on document/window — insertText() alone is invisible to them.
            // - insertText() fires the native `input` event that React-controlled inputs
            //   require to update their state.
            // Together this covers both cases without double-typing.
            const KEY_CODE_MAP: Record<string, string> = {
                '\n': 'Return', '\r': 'Return', '\t': 'Tab', ' ': 'Space',
                '\b': 'Backspace',
            };
            const shouldInsertText = (char: string) => !['\n', '\r', '\t', '\b'].includes(char);
            for (const char of cmd.text) {
                throwIfStopped();
                const keyCode = KEY_CODE_MAP[char] ?? char;
                webviewInfo.wc.sendInputEvent({ type: 'keyDown', keyCode } as any);
                if (shouldInsertText(char)) {
                    // insertText for printable characters (including space) so controlled
                    // inputs and contenteditable targets receive text updates.
                    await webviewInfo.wc.insertText(char);
                }
                webviewInfo.wc.sendInputEvent({ type: 'keyUp', keyCode } as any);
                // Small inter-character delay so rapid keydown events aren't dropped.
                await sleepInterruptible(30, 10);
            }
            if (cmd.pressEnter) {
                // Let input handlers (autocomplete, validation) catch up before submitting.
                await sleepInterruptible(150, 50);
                await executeCommand({ type: "agent:keypress", key: "Enter" });
            }
        } else if (cmd.type === "agent:navigate") {
            if (cmd.new_tab !== false && cmd.url !== "back") {
                // If the URL is already open in a tab the agent may use, switch to it instead of opening a new one.
                const switched = await tabs.switchToTab(cmd.url);
                if (!switched) await tabs.openTab(cmd.url);
            } else {
                await tabs.navigate(cmd.url);
            }
        } else if (cmd.type === "agent:scroll") {
            const webviewInfo = await getAgentSurface();
            if (!webviewInfo) return;
            if (!webviewInfo.foreground) {
                // cmd.x/y/deltas are surface pixels in Electron's wheel convention (positive = up/left).
                const zoom = webviewInfo.wc.getZoomFactor() || 1;
                await scrollInBackground(webviewInfo.wc, cmd.x / zoom, cmd.y / zoom, -(cmd.deltaX ?? 0) / zoom, -(cmd.deltaY ?? 0) / zoom);
                return;
            }
            // Focus both the OS window and the webContents so scroll events are routed correctly.
            getMainWindow()?.focus();
            webviewInfo.wc.focus();
            // Move mouse to the scroll target first so the renderer picks the right element.
            // sendInputEvent needs physical pixels — scale by display factor.
            const scrollWinBounds = getMainWindow()?.getBounds();
            const scrollDisplay = scrollWinBounds
                ? electronScreen.getDisplayNearestPoint({ x: scrollWinBounds.x, y: scrollWinBounds.y })
                : electronScreen.getPrimaryDisplay();
            const scrollSf = scrollDisplay.scaleFactor ?? 1;
            const scrollX = webviewInfo.kind === "renderer" ? Math.round(webviewInfo.x + cmd.x) : cmd.x;
            const scrollY = webviewInfo.kind === "renderer" ? Math.round(webviewInfo.y + cmd.y) : cmd.y;
            const scrollPhysX = Math.round(scrollX * scrollSf);
            const scrollPhysY = Math.round(scrollY * scrollSf);
            webviewInfo.wc.sendInputEvent({ type: 'mouseMove', x: scrollPhysX, y: scrollPhysY, movementX: 0, movementY: 0 } as any);
            // cmd.x/y are already webview-relative — no offset subtraction needed.
            webviewInfo.wc.sendInputEvent({ type: 'mouseWheel', x: scrollPhysX, y: scrollPhysY, deltaX: cmd.deltaX ?? 0, deltaY: cmd.deltaY ?? 0, canScroll: true } as any);
        } else if (cmd.type === "agent:keypress") {
            const webviewInfo = await getAgentSurface();
            if (!webviewInfo) return;
            if (!webviewInfo.foreground) {
                await pressKeyInBackground(webviewInfo.wc, cmd.key);
                console.log(`[Agent] Key pressed (background): ${cmd.key}`);
                return;
            }
            // Ensure the webview has focus so key events aren't silently dropped.
            getMainWindow()?.focus();
            webviewInfo.wc.focus();

            // Parse modifier+key combinations like "ctrl+a", "ctrl+shift+t", etc.
            const MODIFIER_MAP: Record<string, string> = {
                ctrl: 'control', control: 'control',
                shift: 'shift',
                alt: 'alt',
                meta: 'meta', cmd: 'meta', win: 'meta',
            };
            const parts = cmd.key.toLowerCase().split('+');
            const modifiers: string[] = [];
            let keyCode = cmd.key; // fallback to raw value
            if (parts.length > 1) {
                const keyPart = parts[parts.length - 1];
                const modParts = parts.slice(0, -1);
                modParts.forEach(p => {
                    if (MODIFIER_MAP[p]) modifiers.push(MODIFIER_MAP[p]);
                });
                // Preserve original casing of the key character
                const originalParts = cmd.key.split('+');
                keyCode = originalParts[originalParts.length - 1];
            }

            const eventBase = modifiers.length > 0 ? { modifiers } : {};

            // Map well-known key names to their char equivalents so the `char` event
            // (which fires the DOM `keypress` event) contains the right character.
            // This is what React/framework handlers on sites like Amazon listen for.
            const KEY_TO_CHAR: Record<string, string> = {
                Return: '\r', Enter: '\r',
                Tab: '\t',
                Space: ' ', ' ': ' ',
                Backspace: '\b',
                Escape: '\x1b',
            };
            const charValue = KEY_TO_CHAR[keyCode] ?? (keyCode.length === 1 ? keyCode : null);

            webviewInfo.wc.sendInputEvent({ type: 'keyDown', keyCode, ...eventBase } as any);
            // The `char` event is what actually fires the DOM `keypress` event.
            // Without it, React/jQuery handlers on many sites (e.g. Amazon search submit)
            // never receive the keystroke.
            if (charValue) {
                webviewInfo.wc.sendInputEvent({ type: 'char', keyCode: charValue, ...eventBase } as any);
            }
            webviewInfo.wc.sendInputEvent({ type: 'keyUp',   keyCode, ...eventBase } as any);
            console.log(`[Agent] Key pressed: ${cmd.key}${modifiers.length ? ` (modifiers: ${modifiers.join('+')})` : ''}`);
        } else if (cmd.type === "agent:wait") {
            console.log(`[Agent] Waiting ${cmd.seconds}s...`);
            await sleepInterruptible(cmd.seconds * 1000, 100);
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
            // Accept either grid labels (e.g. "c12") or numeric screenshot coordinates.
            const ssCoords = resolveScreenshotPointFromToolArgs(tool_arguments.x, tool_arguments.y, ssW, ssH);
            const clickX = Math.round(ssCoords.x * (winW / ssW));
            const clickY = Math.round(ssCoords.y * (winH / ssH));
            cmd = { type: "agent:click", x: clickX, y: clickY };
        } else if (tool.name === "type") {
            cmd = { type: "agent:type", text: tool_arguments.text, pressEnter: tool_arguments.press_enter === true || tool_arguments.press_enter === "true" };
        } else if (tool.name === "new-tab") {
            cmd = { type: "agent:new-tab", url: tool_arguments.url};
        } else if (tool.name === "navigate") {
            cmd = { type: "agent:navigate", url: tool_arguments.url, new_tab: tool_arguments.new_tab !== false };
        } else if (tool.name === "scroll") {
            // Accept either grid labels or numeric screenshot coordinates.
            const ssPos = resolveScreenshotPointFromToolArgs(tool_arguments.x, tool_arguments.y, ssW, ssH);
            const scrollAtX = Math.round(ssPos.x * (winW / ssW));
            const scrollAtY = Math.round(ssPos.y * (winH / ssH));
            // delta_x/delta_y are column/row counts (can be negative).
            // One column = winW * STEP pixels; one row = winH * STEP pixels.
            // NOTE: Electron's sendInputEvent mouseWheel uses Chromium's internal convention
            // which is inverted vs the web WheelEvent: positive deltaY = scroll UP.
            // Negate so that a positive agent delta_y (meaning "scroll down") works correctly.
            const STEP = 0.015;
            const deltaXPx = -Math.round((tool_arguments.delta_x ?? 0) * winW * STEP);
            const deltaYPx = -Math.round((tool_arguments.delta_y ?? 0) * winH * STEP);
            cmd = { type: "agent:scroll", x: scrollAtX, y: scrollAtY, deltaX: deltaXPx, deltaY: deltaYPx };
        } else if (tool.name === "keypress") {
            cmd = { type: "agent:keypress", key: tool_arguments.key };
        } else if (tool.name === "wait") {
            cmd = { type: "agent:wait", seconds: tool_arguments.seconds ?? 1 };
        } else if (tool.name === "warn") {
            cmd = { type: "agent:warn", message: tool_arguments.message };
        } else if (tool.name === "final_answer") {
            cmd = { type: "agent:final_answer", text: tool_arguments.answer };
        } else if (tool.name === "write_notes") {
            const mode = tool_arguments.mode === "replace" || tool_arguments.mode === "edit" ? tool_arguments.mode : "append";
            cmd = { type: "agent:write_notes", text: String(tool_arguments.text ?? ""), mode, find: typeof tool_arguments.find === "string" ? tool_arguments.find : undefined };
        } else if (tool.name === "read_notes") {
            cmd = { type: "agent:read_notes" };
        } else if (tool.name === "get_tips") {
            cmd = { type: "agent:get_tips", topic: String(tool_arguments.topic ?? "") };
        }
        return cmd;
    }

    /** Label-mode counterpart of getCommand(): click/scroll target elements by their screenshot label.
     * Returns `agent:invalid` (with a reason the model will see) for a label that isn't on screen. */
    function getLabelCommand(tool, elements: LabeledElement[], winW: number, winH: number): any {
        if (!tool) return;

        let tool_arguments: any = {};
        if (tool?.arguments) {
            tool_arguments = typeof tool.arguments === "string"
                ? JSON.parse(tool.arguments)
                : tool.arguments;
        }

        const findElement = (label: unknown) => {
            const key = String(label ?? "").trim().replace(/^\[|\]$/g, "");
            return elements.find(e => e.label === key);
        };

        if (tool.name === "click") {
            const el = findElement(tool_arguments.label);
            if (!el) {
                return { type: "agent:invalid", reason: `failed: no element with label ${JSON.stringify(tool_arguments.label)} on the current screen` };
            }
            return { type: "agent:click", label: el.label, x: el.cx, y: el.cy, clickCount: tool_arguments.click_count ?? 1, element: el.description };
        }
        if (tool.name === "scroll") {
            let anchor = { x: Math.round(winW / 2), y: Math.round(winH / 2) };
            let element: string | undefined;
            if (tool_arguments.label !== undefined && tool_arguments.label !== null && tool_arguments.label !== "") {
                const el = findElement(tool_arguments.label);
                if (!el) {
                    return { type: "agent:invalid", reason: `failed: no element with label ${JSON.stringify(tool_arguments.label)} on the current screen` };
                }
                anchor = { x: el.cx, y: el.cy };
                element = el.description;
            }
            const amount = toNumberIfFinite(tool_arguments.amount) ?? 0.75;
            const direction = String(tool_arguments.direction || "down").toLowerCase();
            // Electron's mouseWheel convention is inverted vs WheelEvent (positive = up/left), see getCommand().
            let deltaX = 0;
            let deltaY = 0;
            if (direction === "down") deltaY = -Math.round(amount * winH);
            else if (direction === "up") deltaY = Math.round(amount * winH);
            else if (direction === "right") deltaX = -Math.round(amount * winW);
            else if (direction === "left") deltaX = Math.round(amount * winW);
            return { type: "agent:scroll", x: anchor.x, y: anchor.y, deltaX, deltaY, element };
        }
        // Remaining tools don't involve on-screen targets and translate the same way as in grid mode.
        return getCommand(tool, winW, winH, winW, winH);
    }

    let past_actions: PastAction[] = [];
    let lastCursorPos: { x: number; y: number } | null = null;
    /** Labels from this agent's latest screenshot. */
    let currentLabels: LabelMap = new Map();

    let agentStopped = false;
    let agentPaused = false;
    let agentRunning = false;

    const MAX_ITERATIONS_PER_TASK = 40;
    const MAX_TASK_DURATION_MS = 5 * 60 * 1000;
    const MAX_SUPERVISOR_INTERVENTIONS_PER_TASK = 3;
    /** Steps to let a refined prompt run before the repetition check may fire again. */
    const SUPERVISOR_COOLDOWN_STEPS = 4;
    /** How many times a final answer can be sent back as unfinished before it's accepted anyway. */
    const MAX_COMPLETION_REJECTIONS = 2;

    function setAgentStopped(v: boolean) {
        agentStopped = v;
        if (v && pendingFetchAbortController) {
            pendingFetchAbortController.abort();
            pendingFetchAbortController = null;
        }
    }
    function isAgentStopped(): boolean { return agentStopped; }
    function setAgentPaused(v: boolean) {
        agentPaused = v;
        // Abort in-flight network calls so pause takes effect immediately.
        if (v && pendingFetchAbortController) {
            pendingFetchAbortController.abort();
            pendingFetchAbortController = null;
        }
    }

    /** Pauses the loop until unpaused or stopped. Returns true if the agent was stopped. */
    async function waitIfPaused(): Promise<boolean> {
        while (agentPaused && !agentStopped) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return agentStopped;
    }

    /**
     * Waits for the DOM in the active webview's guest page to settle after an action.
     * Uses a debounced MutationObserver — resolves only once mutations have stopped
     * arriving for DEBOUNCE_MS, so small cascading changes (e.g. dropdowns, animations)
     * are fully captured before the agent takes its next screenshot.
     * Always waits at least MIN_DELAY_MS regardless of how fast the DOM settles.
     */
    const PAGE_LOAD_TIMEOUT_MS = 5000;

    /** Waits until the main frame finishes loading or `timeoutMs` passes, whichever comes first. */
    async function waitForPageLoad(wc: Electron.WebContents, timeoutMs: number): Promise<void> {
        const end = Date.now() + timeoutMs;
        while (!wc.isDestroyed() && wc.isLoadingMainFrame() && Date.now() < end) {
            await sleepInterruptible(Math.min(100, end - Date.now()), 50);
        }
    }

    /**
     * Runs a script in the page's current main frame. Unlike WebContents.executeJavaScript,
     * this doesn't wait for the page to finish loading. Returns undefined on error or timeout.
     */
    async function runInMainFrame<T>(wc: Electron.WebContents, code: string, timeoutMs: number): Promise<T | undefined> {
        if (wc.isDestroyed()) return undefined;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
        try {
            return await Promise.race([wc.mainFrame.executeJavaScript(code) as Promise<T>, timeout]);
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    }

    async function waitForDomChange(timeout: number): Promise<void> {
        throwIfStopped();
        const MIN_DELAY_MS = 1200;
        const DEBOUNCE_MS  = 400;   // wait this long after the last mutation before resolving
        const MAX_FROM_FIRST_MS = 3000; // hard cap from first detected mutation

        const minDelay = sleepInterruptible(MIN_DELAY_MS, 100);
        // Node-side timeout — guards against a stuck executeJavaScript call
        const nodeTimeout = sleepInterruptible(timeout, 100);
        const webviewInfo = await getAgentSurface();
        if (!webviewInfo) {
            await Promise.all([minDelay, nodeTimeout]);
            return;
        }
        const guestWc = webviewInfo.wc;
        // Race the injected debounced MutationObserver against the Node-side timeout so
        // that if the JS context is destroyed (e.g. page navigation) we don't hang.
        const domChangePromise = Promise.race([
            guestWc.executeJavaScript(`
                new Promise(resolve => {
                    let debounceTimer = null;
                    let firstMutationTimer = null;

                    const settle = () => {
                        if (debounceTimer) clearTimeout(debounceTimer);
                        if (firstMutationTimer) clearTimeout(firstMutationTimer);
                        observer.disconnect();
                        resolve();
                    };

                    const observer = new MutationObserver(() => {
                        // Cap total wait from first mutation so a continuously-mutating
                        // page (e.g. live ticker) doesn't stall the agent indefinitely.
                        if (!firstMutationTimer) {
                            firstMutationTimer = setTimeout(settle, ${MAX_FROM_FIRST_MS});
                        }
                        // Keep resetting the debounce window on every mutation.
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(settle, ${DEBOUNCE_MS});
                    });

                    observer.observe(document.documentElement, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        characterData: true
                    });

                    // Hard outer timeout matches the caller's timeout parameter.
                    setTimeout(settle, ${timeout});
                })
            `).catch(() => {}),
            nodeTimeout,
        ]);
        await Promise.all([minDelay, domChangePromise]);
    }

    type PastAction = { tool: string; parameters: any; explanation: string; result?: string };

    /** Strips per-render state (checked/expanded/value/selected text/...) from an element's
     * description so the same physical element still matches itself across renders even as
     * it toggles, gets typed into, or shows a changing live count. */
    function stableElementKey(description: string): string {
        return description
            .replace(/\s*value="[^"]*"/g, "")
            .replace(/\s*selected="[^"]*"/g, "")
            .replace(/\s*\((?:checked|expanded|selected|disabled|editable)\)/g, "")
            .trim();
    }

    /** Same tool aimed at the same target (e.g. same element, or same click coordinates in
     * grid mode) counts as a repeat regardless of how the model phrases its explanation. */
    function actionTargetKey(action: PastAction): string | null {
        const params = action.parameters || {};
        // Labels are re-numbered every screenshot, so key label actions by the element itself.
        if (typeof params.element === "string") {
            return `${action.tool}:${stableElementKey(params.element)}`;
        }
        if (typeof params.x !== "undefined" && typeof params.y !== "undefined") {
            return `${action.tool}:${params.x}:${params.y}`;
        }
        return null;
    }

    // Generic words that show up in almost every explanation ("click the button on the page")
    // and would otherwise make unrelated actions look like repeats of each other.
    const REPETITION_STOPWORDS = new Set([
        "the", "a", "an", "to", "on", "in", "at", "of", "and", "or", "for", "with", "this",
        "that", "is", "it", "its", "im", "i", "will", "now", "then", "click", "clicking",
        "clicked", "button", "page", "field", "input", "element", "so", "as", "by", "from",
        "into", "up", "down",
    ]);
    // How far back to look for repetition — matches the window the supervisor itself sees.
    const REPETITION_WINDOW = 15;

    function findRepetetion(currentAction: PastAction, past_actions: PastAction[]) {
        function getWords(text: string) {
            return ((text || "").toLowerCase().match(/\b\w+\b/g) || []).filter(w => !REPETITION_STOPWORDS.has(w));
        }
        const recent = past_actions.slice(-(REPETITION_WINDOW + 1)).filter(a => a !== currentAction);
        const currentKey = actionTargetKey(currentAction);
        if (currentKey !== null) {
            // A stable target identity is the reliable signal — trust it alone, since mixing
            // in text overlap would flag unrelated actions just for sharing common wording.
            return recent.filter(action => actionTargetKey(action) === currentKey).length;
        }
        // No stable target available (type/keypress/navigate/wait/unlabeled scroll): fall back
        // to a stricter text-overlap check so generic phrasing alone doesn't count as a repeat.
        const currentWords = new Set(getWords(currentAction.explanation));
        if (currentWords.size === 0) return 0;
        let repeatCount = 0;
        for (const action of recent) {
            const actionWords = new Set(getWords(action.explanation));
            const commonWords = new Set([...currentWords].filter(word => actionWords.has(word)));
            const overlapRatio = commonWords.size / currentWords.size;
            if (commonWords.size >= 3 && overlapRatio >= 0.6) {
                repeatCount++;
            }
        }
        return repeatCount;
    }

    async function runAgentWithInstruction(instruction: string, resumeState: AgentRunResumeState = {}): Promise<string> {
        if (agentRunning) {
            throw new Error("Agent is already running. Stop the current run before starting a new one.");
        }
        agentRunning = true;
        throwIfStopped();
        let finalAnswer = "";
        let currentTaskIndex = 0;
        let plan: AgentTaskPlan;
        let startTaskIndex = 0;

        setAgentNotes(resumeState.notes ?? "");
        showFullNotesNextCall = false;

        try {
            agentStopped = false;
            agentPaused = false;
            // Pause may be toggled while planning. Wait until resumed before continuing.
            while (true) {
                try {
                    if (resumeState.plan) {
                        plan = resumeState.plan;
                    } else {
                        plan = await buildTaskPlan(instruction);
                        // The plan lives in the notepad as a checklist, so it survives Stop and
                        // follow-ups: the next run (and the planner) can see what's still open.
                        if (plan.tasks.length > 1) {
                            writePlanToNotes(plan.tasks);
                        }
                    }
                    break;
                } catch (error) {
                    if (error instanceof AgentPausedError) {
                        if (await waitIfPaused()) {
                            return finalAnswer;
                        }
                        continue;
                    }
                    throw error;
                }
            }

            const tasks = plan.tasks;
            const requestedStartIndex = resumeState.startTaskIndex ?? 0;
            startTaskIndex = Math.min(Math.max(requestedStartIndex, 0), tasks.length - 1);
            currentTaskIndex = startTaskIndex;

            if (startTaskIndex > 0) {
                console.log(`Resuming agent from macro task ${startTaskIndex + 1}/${tasks.length}.`);
            }

            for (let taskIndex = startTaskIndex; taskIndex < tasks.length; taskIndex += 1) {
                currentTaskIndex = taskIndex;
                let currentTask = tasks[taskIndex];
        
                past_actions = [];
                lastCursorPos = null;
                let overridePrompt: string | null = null;
                let iterationCount = 0;
                let supervisorInterventions = 0;
                let completionRejections = 0;
                // Steps left before the repetition check may call the supervisor again. Set
                // after an intervention so the refined prompt gets a real chance to work
                // instead of being re-judged (and re-triggering) on the very next step.
                let supervisorCooldown = 0;
                const taskStartTime = Date.now();

                while (true) {
                    try {
                        // Check stop flag
                        if (agentStopped) break;

                        // Wait if paused (returns true if stopped while paused)
                        if (await waitIfPaused()) break;

                        iterationCount++;
                        if (iterationCount > MAX_ITERATIONS_PER_TASK || Date.now() - taskStartTime > MAX_TASK_DURATION_MS) {
                            console.error(`Agent exceeded step/time budget for task: "${currentTask}"`);
                            emit("agent:warn", `Agent gave up on task after too many steps: "${currentTask}"`);
                            return finalAnswer;
                        }

                        let promptToUse = overridePrompt || currentTask;

                        console.log("Running agent with instruction:", promptToUse);
                        throwIfStopped();

                        let screenshotResult = await takeScreenshot();
                        if (!screenshotResult) {
                            // Give the webview one more chance — wait an extra second and retry once.
                            console.warn("Failed to take screenshot, waiting 2s before one final retry...");
                            await sleepInterruptible(2000, 100);
                            screenshotResult = await takeScreenshot();
                        }
                        if (!screenshotResult) {
                            console.error("Failed to take screenshot after all retries. Aborting agent loop.");
                            throw new Error("Failed to take screenshot after all retries.");
                        }
                        const { base64: screenshot, w: ssW, h: ssH, winW, winH, elements, note: screenNote } = screenshotResult;

                        throwIfStopped();

                        const activeSurface = await getAgentSurface();
                        const currentUrl = activeSurface?.kind === "webview"
                            ? activeSurface.wc.getURL()
                            : undefined;
                        const openTabs = await tabs.listTabs().catch(() => [] as AgentTabInfo[]);
                        const scrollBefore = activeSurface?.kind === "webview" ? await getScrollPosition(activeSurface.wc) : undefined;
                        const response = await GetAction(promptToUse, screenshot, currentUrl, openTabs, TARGETING_MODE === "labels" ? elements : undefined, scrollBefore, promptToUse !== instruction ? instruction : undefined, screenNote);
                        showFullNotesNextCall = false;
                        throwIfStopped();
                        if (!response) {
                            throw new Error("Agent action endpoint returned no response.");
                        }

                        let tool = response?.tool || null;
                        console.log("Agent selected tool:", tool);

                        let tool_arguments: any = {};
                        if (tool?.arguments) {
                            tool_arguments = typeof tool.arguments === "string"
                                ? JSON.parse(tool.arguments)
                                : tool.arguments;
                        }

                        let cmd = TARGETING_MODE === "labels"
                            ? getLabelCommand(tool, elements, winW, winH)
                            : getCommand(tool, winW, winH, ssW, ssH);

                        if (!cmd) {
                            throw new Error(`Unknown tool name: ${tool?.name}`);
                        }

                        // An inline `note` on an action goes straight into the notepad, so the agent can
                        // record what it saw on this screen without spending a step on write_notes.
                        // It's left out of past actions since the notepad already shows it.
                        const { note: rawNote, ...actionArgs } = tool_arguments;
                        const inlineNote = typeof rawNote === "string" ? rawNote.trim() : "";
                        let noteFailure: string | undefined;
                        if (inlineNote && cmd.type !== "agent:write_notes" && cmd.type !== "agent:read_notes") {
                            const noteResult = applyNotesCommand({ type: "agent:write_notes", text: inlineNote, mode: "append" });
                            if (noteResult.startsWith("failed")) noteFailure = `note not saved: ${noteResult}`;
                        }

                        if (cmd.type === "agent:invalid") {
                            // Feed the mistake back to the model instead of aborting the run.
                            console.warn(`[Agent] ${cmd.reason}`);
                            past_actions.push({
                                tool: tool.name,
                                parameters: actionArgs,
                                explanation: tool_arguments.explanation || "No explanation provided.",
                                result: noteFailure ? `${cmd.reason}; ${noteFailure}` : cmd.reason,
                            });
                            continue;
                        }

                        if (cmd.type === "agent:final_answer") {
                            console.log("Agent final answer:", cmd.text);
                            const answer = humanizeFinalAnswer(cmd.text || "");
                            const isLastTask = taskIndex === tasks.length - 1;

                            // Before finishing the whole run, check the answer covers the whole
                            // request — not just the latest message or the current step.
                            if (isLastTask && completionRejections < MAX_COMPLETION_REJECTIONS) {
                                const check = await checkCompletion(instruction, answer);
                                if (check && !check.complete) {
                                    completionRejections++;
                                    const remaining = check.remaining?.trim() || "part of the request";
                                    console.log(`[Agent] Final answer rejected (${completionRejections}/${MAX_COMPLETION_REJECTIONS}); remaining: ${remaining}`);
                                    applyNotesCommand({ type: "agent:write_notes", mode: "append", text: `NOT DONE YET — still to do: ${remaining}` });
                                    past_actions.push({
                                        tool: "final_answer",
                                        parameters: {},
                                        explanation: "Tried to finish.",
                                        result: `rejected: the request isn't fully done. Still to do: ${remaining}. Continue with that, then give the final answer.`,
                                    });
                                    emit("agent:action", `Not finished yet — still to do: ${remaining}`);
                                    // The rest may belong to the whole request rather than this step.
                                    if (tasks.length > 1) overridePrompt = `Finish the overall request. Still to do: ${remaining}`;
                                    continue;
                                }
                            }

                            finalAnswer = answer;
                            // Tick the step off in the notepad's plan checklist.
                            if (tasks.length > 1) {
                                const box = `[ ] ${taskIndex + 1}. `;
                                const done = `Step ${taskIndex + 1} done: ${answer.replace(/\s+/g, " ").slice(0, 160)}`;
                                // Only in this run's plan, the last PLAN block (an earlier request may have left its own).
                                const planStart = agentNotes.lastIndexOf("PLAN (");
                                const boxAt = planStart === -1 ? -1 : agentNotes.indexOf(box, planStart);
                                if (boxAt !== -1) {
                                    setAgentNotes(`${agentNotes.slice(0, boxAt)}[x] ${taskIndex + 1}. ${agentNotes.slice(boxAt + box.length)}\n${done}`);
                                } else {
                                    applyNotesCommand({ type: "agent:write_notes", mode: "append", text: done });
                                }
                            }
                            if (isLastTask) {
                                return finalAnswer; // If this is the last task, we can finish immediately without waiting for the next loop iteration.
                            }
                            break; // Otherwise, break to move on to the next task (if any).
                        }

                        if (cmd.type === "agent:warn") {
                            console.log("Agent warning:", cmd.message);
                            emit("agent:warn", cmd.message || "Agent returned a warning.");
                            return finalAnswer;
                        }

                        if (cmd.type === "agent:write_notes" || cmd.type === "agent:read_notes") {
                            // Notepad tools don't touch the page, so skip the browser action, the
                            // repetition check and the DOM wait. The notes themselves aren't copied
                            // into past actions: the notepad is already in every call.
                            const notesResult = applyNotesCommand(cmd);
                            console.log(`[Agent] ${tool.name}: ${notesResult}`);
                            const notesExplanation = tool_arguments.explanation || (cmd.type === "agent:read_notes" ? "Read my notes." : "Updated my notes.");
                            past_actions.push({
                                tool: tool.name,
                                parameters: cmd.type === "agent:write_notes" ? { mode: cmd.mode, chars: cmd.text.length, ...(cmd.mode === "edit" ? { find: String(cmd.find ?? "").slice(0, 80) } : {}) } : {},
                                explanation: notesExplanation,
                                result: notesResult,
                            });
                            emit("agent:action", notesExplanation);
                            continue;
                        }

                        if (cmd.type === "agent:get_tips") {
                            const tipsResult = applyGetTips(cmd.topic);
                            console.log(`[Agent] get_tips: ${tipsResult}`);
                            const tipsExplanation = tool_arguments.explanation || "Looked up tips.";
                            past_actions.push({ tool: tool.name, parameters: { topic: cmd.topic }, explanation: tipsExplanation, result: tipsResult });
                            emit("agent:action", tipsExplanation);
                            continue;
                        }

                        throwIfStopped();

                        console.log("Executing command:", cmd);
                        await executeCommand(cmd);
                        throwIfStopped();

                        // After a click, capture what element is now focused so the LLM
                        // can confirm the click landed on a search/input box and won't re-click it.
                        let actionResult: string | undefined;
                        if ((cmd.type === "agent:scroll" || cmd.type === "agent:keypress") && scrollBefore) {
                            // Report where the scroll ended up (keys like PageDown/Space/End scroll too),
                            // so the agent knows what it has already looked at.
                            await sleepInterruptible(400, 50); // smooth scrolling
                            const surface = await getAgentSurface();
                            const scrollAfter = surface?.kind === "webview" ? await getScrollPosition(surface.wc) : undefined;
                            if (scrollAfter && (cmd.type === "agent:scroll" || Math.abs(scrollAfter.y - scrollBefore.y) >= 2)) {
                                actionResult = describeScrollChange(scrollBefore, scrollAfter, cmd.type === "agent:scroll" && !!cmd.element);
                            }
                        } else if (cmd.type === "agent:click") {
                            // If the click started a navigation, let it finish — but not for longer than
                            // PAGE_LOAD_TIMEOUT_MS, since ad-heavy pages may never stop loading.
                            const clickedSurface = await getAgentSurface();
                            if (clickedSurface) await waitForPageLoad(clickedSurface.wc, PAGE_LOAD_TIMEOUT_MS);
                            // Re-read the surface: the navigation may have swapped the main frame.
                            const webviewInfo = await getAgentSurface();
                            if (webviewInfo) {
                                // Frame-level call: WebContents.executeJavaScript would wait for the load to finish.
                                actionResult = await runInMainFrame<string>(webviewInfo.wc, `
                                    (() => {
                                        const el = document.activeElement;
                                        if (!el || el === document.body || el === document.documentElement) return "focused: nothing";
                                        const tag = el.tagName.toLowerCase();
                                        const type = el.getAttribute('type') || '';
                                        const placeholder = el.getAttribute('placeholder') || '';
                                        const role = el.getAttribute('role') || '';
                                        const id = el.id ? '#' + el.id : '';
                                        const name = el.getAttribute('name') || '';
                                        const parts = [tag];
                                        if (type) parts.push('[type=' + type + ']');
                                        if (id) parts.push(id);
                                        if (name) parts.push('[name=' + name + ']');
                                        if (role) parts.push('[role=' + role + ']');
                                        if (placeholder) parts.push('placeholder="' + placeholder + '"');
                                        return 'focused: ' + parts.join('');
                                    })()
                                `, 2000);
                            }
                        }

                        const explanation = tool_arguments.explanation || "No explanation provided.";
                        const pushedAction: PastAction = {
                            tool: tool.name,
                            parameters: cmd.element ? { ...actionArgs, element: cmd.element } : actionArgs,
                            explanation,
                            ...(actionResult !== undefined || noteFailure
                                ? { result: [actionResult, noteFailure].filter(Boolean).join("; ") }
                                : {})
                        };
                        past_actions.push(pushedAction);
                        emit("agent:action", explanation);

                        if (supervisorCooldown > 0) {
                            // Give the last intervention's refined prompt a real run before
                            // judging repetition again — otherwise reverting to currentTask
                            // (which may be what pointed the agent at the stuck element in the
                            // first place) re-triggers the supervisor on the very next step.
                            supervisorCooldown--;
                            if (supervisorCooldown === 0) overridePrompt = null;
                        } else {
                            overridePrompt = null; // Clear it so it only applies while the cooldown lasts.
                            let repetitionCount = findRepetetion(pushedAction, past_actions);
                            if (repetitionCount > 2) {
                                throwIfStopped();
                                console.log("______________________________")
                                console.log(`Agent has executed the same action ${repetitionCount} times:`, tool_arguments);
                                const supervisorResponse = await runSupervisor(instruction, plan, currentTaskIndex, screenshot);
                                applyNotesEdits(supervisorResponse?.notes_edits, "supervisor");
                                if (supervisorResponse?.abnormal_repetition) {
                                    console.log("Supervisor detected abnormal repetition.");
                                    supervisorInterventions++;
                                    emit("agent:supervisor", {
                                        count: supervisorInterventions,
                                        limit: MAX_SUPERVISOR_INTERVENTIONS_PER_TASK,
                                        task: currentTask,
                                        refinedPrompt: supervisorResponse.refined_prompt ?? null,
                                    });
                                    if (supervisorInterventions > MAX_SUPERVISOR_INTERVENTIONS_PER_TASK) {
                                        console.error(`Agent stuck: supervisor intervened ${supervisorInterventions} times without resolving repetition on task: "${currentTask}"`);
                                        emit("agent:warn", `Agent appears stuck and could not complete task: "${currentTask}"`);
                                        return finalAnswer;
                                    }
                                    supervisorCooldown = SUPERVISOR_COOLDOWN_STEPS;
                                    if (supervisorResponse.refined_prompt) {
                                        console.log("Supervisor provided a refined prompt: ", supervisorResponse.refined_prompt);
                                        overridePrompt = supervisorResponse.refined_prompt;
                                    }
                                }
                            }
                        }

                        // Wait for any DOM change in the webview.
                        await waitForDomChange(1500);
                    } catch (error) {
                        if (error instanceof AgentPausedError) {
                            if (await waitIfPaused()) break;
                            continue;
                        }
                        throw error;
                    }
                }
            }
            return finalAnswer;
        } catch (error) {
            if (error instanceof AgentStoppedError) {
                console.log("[Agent] Stopped by user.");
                return finalAnswer;
            }
            if (error instanceof AgentPausedError) {
                // If pause escaped this frame, block until resumed/stopped and then return current state.
                await waitIfPaused();
                return finalAnswer;
            }
            if (error instanceof AgentRunError || error instanceof AgentTabClosedError) {
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error ?? "Unknown agent error");
            throw new AgentRunError(message, {
                instruction,
                plan: plan ?? resumeState.plan ?? { complexity: "unknown", tasks: [instruction] },
                resumeTaskIndex: currentTaskIndex,
                notes: agentNotes,
                cause: error,
            });
        } finally {
            agentStopped = false;
            agentPaused = false;
            agentRunning = false;
        }
    }

    return {
        run: runAgentWithInstruction,
        setStopped: setAgentStopped,
        setPaused: setAgentPaused,
        isStopped: isAgentStopped,
    };
}
