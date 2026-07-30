export type AIProtocol = "openai" | "claude" | "gemini";

/** Saved user config for one AI endpoint. Multiple can exist; only one is active. */
export interface AIProviderConfig {
  id: string;
  protocol: AIProtocol;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** true for user-added OpenAI-compatible endpoints */
  custom?: boolean;
}

export interface AIProviderPreset {
  id: string;
  protocol: AIProtocol;
  label: string;
  baseUrl: string;
  model: string;
  keyPlaceholder: string;
  description?: string;
}

const STORAGE_KEYS = {
  AI_PROVIDERS: "ruanzhu_ai_providers",
  AI_ACTIVE_ID: "ruanzhu_ai_active_id",
  // legacy single-provider keys (migrated once)
  AI_PROTOCOL: "ruanzhu_ai_protocol",
  AI_KEY: "ruanzhu_ai_key",
  AI_BASE_URL: "ruanzhu_ai_base_url",
  AI_MODEL: "ruanzhu_ai_model",
  ANTHROPIC_KEY: "ruanzhu_anthropic_key",
  ANTHROPIC_BASE_URL: "ruanzhu_anthropic_base_url",
  ANTHROPIC_MODEL: "ruanzhu_anthropic_model",
  PROJECTS: "ruanzhu_projects",
  AGREED: "ruanzhu_agreed",
  MANUAL_DRAFT_PREFIX: "ruanzhu_manual_draft_",
};

/** Built-in provider templates shown in settings. */
export const AI_PROVIDER_PRESETS: AIProviderPreset[] = [
  {
    id: "openai",
    protocol: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    model: "gpt-4o",
    keyPlaceholder: "sk-xxxx",
    description: "官方 OpenAI Chat Completions",
  },
  {
    id: "claude",
    protocol: "claude",
    label: "Claude",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    keyPlaceholder: "sk-ant-xxxx",
    description: "Anthropic Messages API",
  },
  {
    id: "gemini",
    protocol: "gemini",
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.0-flash",
    keyPlaceholder: "AIzaSy-xxxx",
    description: "Google Generative Language API",
  },
  {
    id: "deepseek",
    protocol: "openai",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    keyPlaceholder: "sk-xxxx",
    description: "OpenAI 兼容接口",
  },
  {
    id: "qwen",
    protocol: "openai",
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    model: "qwen-plus",
    keyPlaceholder: "sk-xxxx",
    description: "阿里云 DashScope OpenAI 兼容",
  },
  {
    id: "moonshot",
    protocol: "openai",
    label: "Kimi (月之暗面)",
    baseUrl: "https://api.moonshot.cn",
    model: "moonshot-v1-128k",
    keyPlaceholder: "sk-xxxx",
    description: "OpenAI 兼容接口",
  },
  {
    id: "zhipu",
    protocol: "openai",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    keyPlaceholder: "xxxx.xxxx",
    description: "OpenAI 兼容接口",
  },
  {
    id: "openrouter",
    protocol: "openai",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    model: "openai/gpt-4o",
    keyPlaceholder: "sk-or-xxxx",
    description: "多模型聚合，OpenAI 兼容",
  },
];

/** @deprecated use AI_PROVIDER_PRESETS — kept for older imports */
export const AI_DEFAULTS: Record<AIProtocol, { baseUrl: string; model: string; keyPlaceholder: string; label: string }> = {
  openai: { baseUrl: "https://api.openai.com", model: "gpt-4o", keyPlaceholder: "sk-xxxx", label: "OpenAI" },
  claude: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-6", keyPlaceholder: "sk-ant-xxxx", label: "Claude" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash", keyPlaceholder: "AIzaSy-xxxx", label: "Gemini" },
};

function isProtocol(v: unknown): v is AIProtocol {
  return v === "openai" || v === "claude" || v === "gemini";
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function generateProviderId(): string {
  return "custom-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function readProvidersRaw(): AIProviderConfig[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEYS.AI_PROVIDERS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is AIProviderConfig =>
        !!p &&
        typeof p === "object" &&
        typeof (p as AIProviderConfig).id === "string" &&
        isProtocol((p as AIProviderConfig).protocol)
      )
      .map((p) => ({
        id: p.id,
        protocol: p.protocol,
        label: typeof p.label === "string" && p.label ? p.label : p.id,
        apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
        baseUrl: normalizeBaseUrl(typeof p.baseUrl === "string" ? p.baseUrl : ""),
        model: typeof p.model === "string" ? p.model : "",
        custom: !!p.custom,
      }));
  } catch {
    return [];
  }
}

function writeProviders(providers: AIProviderConfig[]) {
  localStorage.setItem(STORAGE_KEYS.AI_PROVIDERS, JSON.stringify(providers));
}

/** Migrate legacy single-provider keys + anthropic-only keys into multi-provider store. */
function migrateIfNeeded() {
  if (typeof window === "undefined") return;

  // Already on multi-provider format
  if (localStorage.getItem(STORAGE_KEYS.AI_PROVIDERS)) {
    // Ensure active id points to an existing configured provider
    const providers = readProvidersRaw();
    const active = localStorage.getItem(STORAGE_KEYS.AI_ACTIVE_ID);
    if (active && !providers.some((p) => p.id === active && p.apiKey)) {
      const first = providers.find((p) => p.apiKey);
      if (first) localStorage.setItem(STORAGE_KEYS.AI_ACTIVE_ID, first.id);
      else localStorage.removeItem(STORAGE_KEYS.AI_ACTIVE_ID);
    }
    return;
  }

  const providers: AIProviderConfig[] = [];

  // Legacy single config
  const legacyKey = localStorage.getItem(STORAGE_KEYS.AI_KEY);
  if (legacyKey) {
    const protocolRaw = localStorage.getItem(STORAGE_KEYS.AI_PROTOCOL);
    const protocol: AIProtocol = isProtocol(protocolRaw) ? protocolRaw : "openai";
    const preset = AI_PROVIDER_PRESETS.find((p) => p.id === protocol) || AI_PROVIDER_PRESETS[0];
    providers.push({
      id: preset.id,
      protocol,
      label: preset.label,
      apiKey: legacyKey,
      baseUrl: normalizeBaseUrl(localStorage.getItem(STORAGE_KEYS.AI_BASE_URL) || preset.baseUrl),
      model: localStorage.getItem(STORAGE_KEYS.AI_MODEL) || preset.model,
    });
  } else {
    // Even older anthropic-only keys
    const oldKey = localStorage.getItem(STORAGE_KEYS.ANTHROPIC_KEY);
    if (oldKey) {
      const preset = AI_PROVIDER_PRESETS.find((p) => p.id === "claude")!;
      providers.push({
        id: "claude",
        protocol: "claude",
        label: preset.label,
        apiKey: oldKey,
        baseUrl: normalizeBaseUrl(localStorage.getItem(STORAGE_KEYS.ANTHROPIC_BASE_URL) || preset.baseUrl),
        model: localStorage.getItem(STORAGE_KEYS.ANTHROPIC_MODEL) || preset.model,
      });
    }
  }

  writeProviders(providers);
  if (providers[0]) {
    localStorage.setItem(STORAGE_KEYS.AI_ACTIVE_ID, providers[0].id);
  }
}

export function getAIProviders(): AIProviderConfig[] {
  if (typeof window === "undefined") return [];
  migrateIfNeeded();
  return readProvidersRaw();
}

export function getActiveProviderId(): string | null {
  if (typeof window === "undefined") return null;
  migrateIfNeeded();
  return localStorage.getItem(STORAGE_KEYS.AI_ACTIVE_ID);
}

export function getActiveProvider(): AIProviderConfig | null {
  const id = getActiveProviderId();
  if (!id) return null;
  const p = getAIProviders().find((x) => x.id === id);
  if (!p || !p.apiKey) return null;
  return p;
}

/**
 * Enable exactly one provider. Clears active if the provider has no key.
 * Only one provider can be active at a time.
 */
export function setActiveProviderId(id: string | null) {
  migrateIfNeeded();
  if (!id) {
    localStorage.removeItem(STORAGE_KEYS.AI_ACTIVE_ID);
    return;
  }
  const providers = readProvidersRaw();
  const target = providers.find((p) => p.id === id);
  if (!target || !target.apiKey.trim()) {
    throw new Error("只能启用已配置 API Key 的提供商");
  }
  localStorage.setItem(STORAGE_KEYS.AI_ACTIVE_ID, id);
}

/** Create or update a provider config. Does not change active selection by itself. */
export function upsertAIProvider( partial: {
  id?: string;
  protocol: AIProtocol;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  custom?: boolean;
  /** if true, also make this the only active provider (requires non-empty key) */
  activate?: boolean;
}): AIProviderConfig {
  migrateIfNeeded();
  const providers = readProvidersRaw();
  const id = partial.id || generateProviderId();
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === id);
  const next: AIProviderConfig = {
    id,
    protocol: partial.protocol,
    label: partial.label.trim() || preset?.label || id,
    apiKey: partial.apiKey.trim(),
    baseUrl: normalizeBaseUrl(partial.baseUrl.trim() || preset?.baseUrl || ""),
    model: partial.model.trim() || preset?.model || "",
    custom: partial.custom ?? (!preset),
  };

  const idx = providers.findIndex((p) => p.id === id);
  if (idx >= 0) providers[idx] = next;
  else providers.push(next);
  writeProviders(providers);

  if (partial.activate) {
    if (!next.apiKey) throw new Error("启用提供商前请先填写 API Key");
    localStorage.setItem(STORAGE_KEYS.AI_ACTIVE_ID, id);
  } else {
    // If we cleared the key of the currently active provider, deactivate it
    const active = localStorage.getItem(STORAGE_KEYS.AI_ACTIVE_ID);
    if (active === id && !next.apiKey) {
      localStorage.removeItem(STORAGE_KEYS.AI_ACTIVE_ID);
    }
  }

  return next;
}

export function removeAIProvider(id: string) {
  migrateIfNeeded();
  const providers = readProvidersRaw().filter((p) => p.id !== id);
  writeProviders(providers);
  if (localStorage.getItem(STORAGE_KEYS.AI_ACTIVE_ID) === id) {
    const next = providers.find((p) => p.apiKey);
    if (next) localStorage.setItem(STORAGE_KEYS.AI_ACTIVE_ID, next.id);
    else localStorage.removeItem(STORAGE_KEYS.AI_ACTIVE_ID);
  }
}

export function createCustomProviderDraft(): AIProviderConfig {
  return {
    id: generateProviderId(),
    protocol: "openai",
    label: "自定义 OpenAI 兼容",
    apiKey: "",
    baseUrl: "https://api.example.com",
    model: "gpt-4o",
    custom: true,
  };
}

export function getProviderPreset(id: string): AIProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((p) => p.id === id);
}

export function getMergedProviderView(): Array<AIProviderConfig & { configured: boolean; active: boolean; isPreset: boolean }> {
  const saved = getAIProviders();
  const activeId = getActiveProviderId();
  const byId = new Map(saved.map((p) => [p.id, p]));

  const rows: Array<AIProviderConfig & { configured: boolean; active: boolean; isPreset: boolean }> = [];

  for (const preset of AI_PROVIDER_PRESETS) {
    const s = byId.get(preset.id);
    const config: AIProviderConfig = s || {
      id: preset.id,
      protocol: preset.protocol,
      label: preset.label,
      apiKey: "",
      baseUrl: preset.baseUrl,
      model: preset.model,
      custom: false,
    };
    rows.push({
      ...config,
      configured: !!config.apiKey,
      active: activeId === config.id && !!config.apiKey,
      isPreset: true,
    });
    byId.delete(preset.id);
  }

  // remaining custom providers
  for (const s of byId.values()) {
    rows.push({
      ...s,
      configured: !!s.apiKey,
      active: activeId === s.id && !!s.apiKey,
      isPreset: false,
    });
  }

  return rows;
}

// ── Legacy single-provider getters (read from active provider) ──

export function getAIProtocol(): AIProtocol {
  return getActiveProvider()?.protocol || "openai";
}

export function setAIProtocol(protocol: AIProtocol) {
  const active = getActiveProvider();
  if (active) {
    upsertAIProvider({ ...active, protocol });
    return;
  }
  // no active — stash on matching preset if present
  const preset = AI_PROVIDER_PRESETS.find((p) => p.protocol === protocol) || AI_PROVIDER_PRESETS[0];
  upsertAIProvider({
    id: preset.id,
    protocol,
    label: preset.label,
    apiKey: "",
    baseUrl: preset.baseUrl,
    model: preset.model,
  });
}

export function getAIKey(): string | null {
  const key = getActiveProvider()?.apiKey;
  return key || null;
}

export function setAIKey(key: string) {
  const active = getActiveProvider();
  if (active) {
    upsertAIProvider({ ...active, apiKey: key, activate: !!key.trim() });
    return;
  }
  const protocol = getAIProtocol();
  const preset = AI_PROVIDER_PRESETS.find((p) => p.protocol === protocol) || AI_PROVIDER_PRESETS[0];
  upsertAIProvider({
    id: preset.id,
    protocol: preset.protocol,
    label: preset.label,
    apiKey: key,
    baseUrl: getAIBaseUrl(),
    model: getAIModel(),
    activate: !!key.trim(),
  });
}

export function getAIBaseUrl(): string {
  const active = getActiveProvider();
  if (active?.baseUrl) return active.baseUrl;
  return AI_DEFAULTS.openai.baseUrl;
}

export function setAIBaseUrl(url: string) {
  const active = getActiveProvider();
  if (active) {
    upsertAIProvider({ ...active, baseUrl: url });
    return;
  }
  localStorage.setItem(STORAGE_KEYS.AI_BASE_URL, normalizeBaseUrl(url));
}

export function getAIModel(): string {
  const active = getActiveProvider();
  if (active?.model) return active.model;
  return AI_DEFAULTS.openai.model;
}

export function setAIModel(model: string) {
  const active = getActiveProvider();
  if (active) {
    upsertAIProvider({ ...active, model });
    return;
  }
  localStorage.setItem(STORAGE_KEYS.AI_MODEL, model);
}

// ── User agreement ──

export function hasAgreed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(STORAGE_KEYS.AGREED) === "true";
}

export function setAgreed() {
  localStorage.setItem(STORAGE_KEYS.AGREED, "true");
}

// ── Manual generation drafts (resume after failure) ──

export interface ManualDraft {
  projectId: string;
  softwareName: string;
  version: string;
  markdown: string;
  lines: number;
  attempt: number;
  updatedAt: string;
  /** true when target line count was reached */
  complete?: boolean;
  /** chapter index for chapter-wise generation resume (0-based) */
  nextChapterIndex?: number;
}

function draftKey(projectId: string) {
  return STORAGE_KEYS.MANUAL_DRAFT_PREFIX + projectId;
}

export function getManualDraft(projectId: string): ManualDraft | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(draftKey(projectId));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as ManualDraft;
    if (!d || typeof d.markdown !== "string") return null;
    return d;
  } catch {
    return null;
  }
}

export function saveManualDraft(draft: ManualDraft) {
  if (typeof window === "undefined") return;
  // Draft saves happen after every chapter; a quota failure here must not abort
  // the generation that is still producing useful text.
  try {
    localStorage.setItem(draftKey(draft.projectId), JSON.stringify(draft));
  } catch {
    /* draft is a convenience — generation continues without it */
  }
}

export function clearManualDraft(projectId: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(draftKey(projectId));
}

// ── Software metadata ──

export interface SoftwareMeta {
  devHardware: string;
  runHardware: string;
  devOS: string;
  devTools: string;
  runPlatform: string;
  runSupport: string;
  category: string;
  sourceLines: number;
  purpose: string;
  domain: string;
  mainFeatures: string;
  technicalFeatures: string;
  languagesGiven: string[];
  languagesExtra: string[];
  techCategoriesGiven: string[];
  techCategoriesExtra: string[];
  softwareDescription: string;
  originalType: string;
  devMethod: string;
  publishStatus: string;
}

export function createEmptyMeta(): SoftwareMeta {
  return {
    devHardware: "", runHardware: "", devOS: "", devTools: "",
    runPlatform: "", runSupport: "", category: "应用软件", sourceLines: 0,
    purpose: "", domain: "", mainFeatures: "", technicalFeatures: "",
    languagesGiven: [], languagesExtra: [],
    techCategoriesGiven: [], techCategoriesExtra: [],
    softwareDescription: "", originalType: "原创", devMethod: "单独开发", publishStatus: "未发表",
  };
}

// ── Project data ──

export interface Project {
  id: string;
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  /**
   * GitHub repo description. Distinct from `repoUrl` — AI prompts need the prose
   * description, not the link. Optional because projects created before this
   * field existed don't have it; the detail page backfills it from the API.
   */
  repoDescription?: string;
  defaultBranch: string;
  softwareName: string;
  version: string;
  completedAt?: string;
  status: "PENDING" | "PROCESSING" | "DONE" | "FAILED";
  meta: SoftwareMeta;
  errorMsg?: string;
  createdAt: string;
  /** Editable 文档鉴别材料 markdown (persisted after generation) */
  manualMarkdown?: string;
  /**
   * Lightweight repo snapshot used by AI 核对/审核 so those features work after a
   * page refresh without re-downloading the repo. Populated during metadata
   * auto-detection (so 核对 works before the first full generation) and refreshed
   * with richer code excerpts when materials are generated.
   */
  reviewContext?: {
    fileTree: string;
    languages: string;
    codeSummary: string;
    /** README excerpt — the strongest signal for purpose/feature review */
    readme?: string;
    /** Module directory layout */
    moduleDirs?: string;
  };
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Write a key, surfacing quota exhaustion as a readable error.
 *
 * Manuals run to hundreds of KB and localStorage caps around 5 MB per origin, so
 * a few large projects can fill it. An unhandled QuotaExceededError thrown from a
 * render path takes the whole page down, so callers get a real message instead.
 */
function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (/quota|QUOTA_EXCEEDED/i.test(name) || /quota/i.test(String(e))) {
      throw new Error(
        "浏览器本地存储空间已满，无法保存。请删除不再需要的项目，或下载已生成的材料后清理，然后重试。"
      );
    }
    throw e;
  }
}

export function getProjects(): Project[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEYS.PROJECTS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getProject(id: string): Project | undefined {
  return getProjects().find((p) => p.id === id);
}

export function createProject(data: Omit<Project, "id" | "status" | "createdAt">): Project {
  const project: Project = { ...data, id: generateId(), status: "PENDING", createdAt: new Date().toISOString() };
  const projects = getProjects();
  projects.unshift(project);
  writeStorage(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
  return project;
}

export function updateProject(id: string, updates: Partial<Project>) {
  const projects = getProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx >= 0) {
    projects[idx] = { ...projects[idx], ...updates };
    writeStorage(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
  }
}

export function deleteProject(id: string) {
  const projects = getProjects().filter((p) => p.id !== id);
  writeStorage(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
}

export function deleteProjects(ids: string[]) {
  const idSet = new Set(ids);
  const projects = getProjects().filter((p) => !idSet.has(p.id));
  writeStorage(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
}
