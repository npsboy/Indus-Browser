import { useState } from "react";

type ApiResponse = {
  error?: boolean;
  data?: unknown;
  status?: number;
  text?: string;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Classifier request timed out"));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function parseIsTask(value: unknown): boolean | null {
  if (!value) return null;

  if (typeof value === "string") {
    const trimmed = value
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();

    try {
      return parseIsTask(JSON.parse(trimmed));
    } catch {
      const match = trimmed.match(/isTask\s*[:=]\s*(true|false)/i);
      return match ? match[1].toLowerCase() === "true" : null;
    }
  }

  if (typeof value !== "object") return null;

  const data = value as Record<string, unknown>;
  if (typeof data.isTask === "boolean") return data.isTask;

  for (const key of ["reply", "output", "message", "content", "data"]) {
    const nested = parseIsTask(data[key]);
    if (nested !== null) return nested;
  }

  return null;
}

export function useTaskSuggestion() {
  const [pendingTaskSuggestion, setPendingTaskSuggestion] = useState<string | null>(null);

  async function suggest(text: string) {
    try {
      const request = window.api?.classifyChatInput?.(text);
      if (!request) return;
      const response = await withTimeout<ApiResponse>(request, 2500);
      const isTask = !response?.error ? parseIsTask(response?.data) : null;
      if (isTask) {
        setPendingTaskSuggestion(text);
      }
    } catch {
      // Classification is best-effort; silently skip the suggestion on failure.
    }
  }

  function clear() {
    setPendingTaskSuggestion(null);
  }

  return { pendingTaskSuggestion, suggest, clear };
}
