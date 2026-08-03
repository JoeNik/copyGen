import type { AIModelOption, AIProtocol } from "@/lib/ai/contracts";

export interface DiagnosticsCredentials {
  protocol: AIProtocol;
  baseUrl: string;
  model?: string;
  apiKey: string;
}

export interface DiagnosticsErrorPayload {
  code: string;
  message: string;
  suggestion?: string;
  status?: number;
  host?: string;
  requestId?: string;
}

export class DiagnosticsError extends Error {
  public readonly code: string;
  public readonly suggestion?: string;
  public readonly host?: string;

  constructor(payload: DiagnosticsErrorPayload) {
    super(payload.message);
    this.name = "DiagnosticsError";
    this.code = payload.code;
    this.suggestion = payload.suggestion;
    this.host = payload.host;
  }
}

export type { AIModelOption } from "@/lib/ai/contracts";

/** Fetch the provider's model list. Returns [] when the provider doesn't support listing. */
export async function fetchModels(creds: DiagnosticsCredentials): Promise<AIModelOption[]> {
  const res = await fetch("/api/ai/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(creds),
  });

  if (!res.ok) {
    throw await toDiagnosticsError(res);
  }

  const data = (await res.json()) as { models: AIModelOption[] };
  return data.models ?? [];
}

export interface ModelTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  output: string;
  warning?: string;
}

/** Run a minimal real-generation test against the configured model. */
export async function testModel(
  creds: Omit<DiagnosticsCredentials, "model"> & { model: string },
): Promise<ModelTestResult> {
  const res = await fetch("/api/ai/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(creds),
  });

  if (!res.ok) {
    throw await toDiagnosticsError(res);
  }

  return (await res.json()) as ModelTestResult;
}

async function toDiagnosticsError(res: Response): Promise<DiagnosticsError> {
  let body: { error?: DiagnosticsErrorPayload } | null = null;
  try {
    body = (await res.json()) as { error?: DiagnosticsErrorPayload };
  } catch {
    body = null;
  }
  const err = body?.error;
  if (err) {
    return new DiagnosticsError(err);
  }
  return new DiagnosticsError({
    code: "UPSTREAM_HTTP_ERROR",
    message: `接口错误 (${res.status})`,
  });
}