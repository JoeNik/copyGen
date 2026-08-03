/** Client-safe types — no server dependencies, no secrets. */

export type AIProtocol = "openai" | "claude" | "gemini";

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AICompletion {
  text: string;
  finishReason: string;
}

export interface AIModelOption {
  id: string;
  displayName?: string;
  description?: string;
  capabilities?: string[];
}

/** Normalised SSE events emitted by the server-side stream adapter. */
export type SSEDeltaEvent = { event: "delta"; data: { text: string } };
export type SSEDoneEvent = { event: "done"; data: { finishReason: string } };
export type SSEErrorEvent = { event: "error"; data: { code: string; message: string } };
export type SSEEvent = SSEDeltaEvent | SSEDoneEvent | SSEErrorEvent;