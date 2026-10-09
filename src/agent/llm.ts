/**
 * Talks to OpenRouter through the backend Worker. The Worker only picks the model for a
 * role and adds the API key; everything else in a request (messages, tools, response
 * format, streaming) is built here, and OpenRouter's response comes back unchanged.
 */

const BACKEND_URL = "https://indus-backend.tushar-vijayanagar.workers.dev/llm";

/** Roles the backend has a model for. */
export type AgentRole = "planner" | "supervisor" | "agent" | "conversant" | "titler" | "decider";

export type LlmMessage = {
    role: "system" | "user" | "assistant";
    content: unknown;
    /** Adds a prompt-cache breakpoint: everything up to and including this message is cached. */
    cache?: boolean;
};

export type ToolCall = { name: string; arguments: string };

/** Sends `payload` (an OpenRouter request body, without `model`) for `agentRole`. */
export function postLlm(agentRole: AgentRole, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentRole, payload }),
        signal,
    });
}

/**
 * Converts messages to OpenRouter content-part messages, with prompt caching.
 * A message with `cache: true` gets an Anthropic `cache_control` breakpoint, so
 * everything up to and including it (tools + that prompt) is cached and reused across
 * steps. Consecutive system messages are merged into one multi-part system message so
 * a static, cached prompt can be followed by per-step system text without busting the cache.
 * An image, if given, is sent as a final user message.
 */
export function buildMessages(messages: LlmMessage[], imageUrl?: string) {
    const out: { role: string; content: Record<string, unknown>[] }[] = [];
    for (const m of messages) {
        const part: Record<string, unknown> = { type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
        if (m.cache) part.cache_control = { type: "ephemeral" };
        const prev = out[out.length - 1];
        if (m.role === "system" && prev?.role === "system") {
            prev.content.push(part);
        } else {
            out.push({ role: m.role, content: [part] });
        }
    }
    if (imageUrl) {
        out.push({ role: "user", content: [{ type: "image_url", image_url: { url: imageUrl } }] });
    }
    return out;
}

/** The assistant message of a chat completion response: its text and first tool call. */
export function readCompletion(data: any): { reply: string; tool: ToolCall | null } {
    const message = data?.choices?.[0]?.message;
    const fn = message?.tool_calls?.[0]?.function;
    return {
        reply: typeof message?.content === "string" ? message.content : "",
        tool: fn ? { name: fn.name, arguments: fn.arguments } : null,
    };
}

/** Request body for a reply in JSON mode (planner, supervisor and the checks). */
export function jsonModePayload(messages: LlmMessage[], imageUrl?: string) {
    return { messages: buildMessages(messages, imageUrl), response_format: { type: "json_object" } };
}

/**
 * Parses a JSON-mode reply. Some models still wrap it in a ```json fence or add text around
 * it, so fall back to the outermost {...} when the reply isn't plain JSON. Throws if none parses.
 */
export function parseJsonReply(reply: string): any {
    try {
        return JSON.parse(reply);
    } catch (error) {
        const start = reply.indexOf("{");
        const end = reply.lastIndexOf("}");
        if (start === -1 || end <= start) throw error;
        return JSON.parse(reply.slice(start, end + 1));
    }
}

/** Asks the decision model (Jev): state + typed questions in, typed answers out. */
export async function askDecider(state: Record<string, unknown>, questions: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const response = await postLlm("decider", { state, questions }, signal);
    if (!response.ok) {
        throw new LlmEndpointError(response.status, await response.text());
    }
    const answers = (await response.json())?.answers;
    if (!answers || typeof answers !== "object") {
        throw new LlmEndpointError(0, "Decider returned no answers");
    }
    return answers;
}

export class LlmEndpointError extends Error {
    readonly status: number;
    readonly body: string;

    constructor(status: number, body: string) {
        super(`LLM endpoint returned ${status}: ${body}`);
        this.name = "LlmEndpointError";
        this.status = status;
        this.body = body;
    }
}
