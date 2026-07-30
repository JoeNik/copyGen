/**
 * Live generation runs, held outside React.
 *
 * A generation is a long async chain (GitHub fetch → AI chapters → PDF render).
 * It is NOT tied to the component that started it: navigating away unmounts the
 * page but the promise keeps running to completion. Previously the page treated
 * unmount as "interrupted" and wrote FAILED to storage, which was a lie — the
 * work was still in flight, and the resume UI invited the user to start a second
 * concurrent run over the same draft.
 *
 * This registry lets a remounted page find the run that is still going, re-attach
 * to its progress, and collect its result.
 */

export interface GenerationProgress {
  /** Index into the page's step list; -1 before the first step. */
  stepIndex: number;
  /** 0–100 */
  progress: number;
  currentStep: string;
}

export interface GenerationResult {
  markdown: string;
  codePdf: Blob;
  manualPdf: Blob;
  sourceLines: number;
}

export type GenerationEmit = (patch: Partial<GenerationProgress>) => void;

export type RunStatus = "running" | "done" | "error";

export interface RunSnapshot {
  status: RunStatus;
  progress: GenerationProgress;
  result?: GenerationResult;
  error?: string;
  startedAt: number;
}

interface GenerationRun {
  status: RunStatus;
  progress: GenerationProgress;
  startedAt: number;
  result?: GenerationResult;
  error?: string;
}

const runs = new Map<string, GenerationRun>();
/** Listeners live independently of runs so a page can subscribe before start. */
const listeners = new Map<string, Set<() => void>>();

function notify(projectId: string) {
  const set = listeners.get(projectId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener();
    } catch {
      /* a broken listener must not stop the run */
    }
  }
}

export function getRun(projectId: string): RunSnapshot | null {
  const run = runs.get(projectId);
  if (!run) return null;
  return {
    status: run.status,
    progress: { ...run.progress },
    result: run.result,
    error: run.error,
    startedAt: run.startedAt,
  };
}

export function isRunning(projectId: string): boolean {
  return runs.get(projectId)?.status === "running";
}

/** True while any project in this tab has a generation in flight. */
export function hasAnyRunning(): boolean {
  for (const run of runs.values()) {
    if (run.status === "running") return true;
  }
  return false;
}

/** Subscribe to progress/status changes. Returns an unsubscribe function. */
export function subscribeToRun(projectId: string, listener: () => void): () => void {
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(projectId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(projectId);
  };
}

/**
 * Start a generation for `projectId`. If one is already running, nothing is
 * started and `started: false` is returned — this is what prevents a stray
 * "从断点继续" click from launching a second writer over the same draft.
 */
export function startRun(
  projectId: string,
  task: (emit: GenerationEmit) => Promise<GenerationResult>
): { started: boolean } {
  if (runs.get(projectId)?.status === "running") return { started: false };

  const run: GenerationRun = {
    status: "running",
    progress: { stepIndex: -1, progress: 0, currentStep: "准备中..." },
    startedAt: Date.now(),
  };
  runs.set(projectId, run);

  const emit: GenerationEmit = (patch) => {
    // Ignore emits from a superseded run (project was reset and restarted).
    if (runs.get(projectId) !== run) return;
    run.progress = { ...run.progress, ...patch };
    notify(projectId);
  };

  // Kick off without awaiting: the run outlives the caller's component.
  void (async () => {
    try {
      const result = await task(emit);
      if (runs.get(projectId) !== run) return;
      run.status = "done";
      run.result = result;
    } catch (e) {
      if (runs.get(projectId) !== run) return;
      run.status = "error";
      run.error = e instanceof Error ? e.message : String(e);
    }
    notify(projectId);
  })();

  notify(projectId);
  return { started: true };
}

/**
 * Read and remove a finished run's outcome. Called by the page once it has
 * applied the result to its own state, so the outcome is delivered exactly once
 * while a still-running entry is left alone.
 */
export function takeFinishedRun(
  projectId: string
): { result?: GenerationResult; error?: string } | null {
  const run = runs.get(projectId);
  if (!run || run.status === "running") return null;
  runs.delete(projectId);
  return { result: run.result, error: run.error };
}

/** Drop a run without reading it (e.g. project reset). */
export function forgetRun(projectId: string) {
  runs.delete(projectId);
}
