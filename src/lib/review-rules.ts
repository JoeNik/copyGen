/**
 * User-extensible 软著 review rules.
 *
 * The built-in rules encode what this tool knows about 形式审查; they stay in code
 * because they're wired into how prompts are structured. Everything a user learns
 * from elsewhere — a colleague's experience, a rule-collection repo — lands in the
 * editable buckets below and is appended to the prompts verbatim.
 *
 * Two buckets, because the two jobs pull in opposite directions: audit rules make
 * the reviewer stricter, writing rules make the generator produce text that passes.
 * Mixing them made the reviewer flag its own instructions.
 */

const STORAGE_KEY = "ruanzhu_review_rules";

export interface RuleSource {
  label: string;
  url: string;
  addedAt: string;
}

export interface ReviewRules {
  /** Extra rules appended to 审核说明书 / AI 核对 prompts. */
  auditRules: string;
  /** Extra guidance appended to document-generation prompts. */
  writingRules: string;
  /** Where imported rules came from, for provenance. */
  sources: RuleSource[];
  updatedAt: string;
}

/** Shipped defaults — shown in the editor as a starting point, fully replaceable. */
export const DEFAULT_AUDIT_RULES = `# 审核补充规则（可自行修改）
- 说明书与登记表的「主要功能」必须逐条对应：登记表写了的功能，说明书里应当有对应章节或小节。
- 全文的软件全称、版本号必须一致，且与登记表一致；不要出现旧名称或其它版本号。
- 界面截图占位（[图X-X：描述]）应分布在各功能章节，不要集中在一两章。
- 操作步骤必须是可执行的：有前置条件、有编号步骤、有预期结果。
- 不要出现"本文档由 AI 生成""以下为示例"这类元信息表述。
- 不要出现具体的公司名、人名、真实域名、真实 IP、真实账号密码。`;

export const DEFAULT_WRITING_RULES = `# 撰写补充要求（可自行修改）
- 每个功能模块按「功能说明 → 前置条件 → 操作步骤 → 结果确认 → 注意事项」的顺序写。
- 术语全文统一：同一个模块只用一个名字，不要交替使用近义词。
- 描述界面时用"页面/区域/按钮/列表"等通用词，不要虚构具体的控件坐标或颜色值。
- 举例数据一律使用示例值（如"示例用户""XX单位"），不要写真实姓名、真实单位、真实联系方式。`;

function emptyRules(): ReviewRules {
  return {
    auditRules: DEFAULT_AUDIT_RULES,
    writingRules: DEFAULT_WRITING_RULES,
    sources: [],
    updatedAt: new Date().toISOString(),
  };
}

export function getReviewRules(): ReviewRules {
  if (typeof window === "undefined") return emptyRules();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyRules();
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewRules>;
    return {
      auditRules: typeof parsed.auditRules === "string" ? parsed.auditRules : DEFAULT_AUDIT_RULES,
      writingRules: typeof parsed.writingRules === "string" ? parsed.writingRules : DEFAULT_WRITING_RULES,
      sources: Array.isArray(parsed.sources)
        ? parsed.sources.filter((s): s is RuleSource => !!s && typeof s.url === "string")
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return emptyRules();
  }
}

export function saveReviewRules(rules: Omit<ReviewRules, "updatedAt">): ReviewRules {
  const next: ReviewRules = { ...rules, updatedAt: new Date().toISOString() };
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      throw new Error("浏览器本地存储空间已满，无法保存审核规则");
    }
  }
  return next;
}

export function resetReviewRules(): ReviewRules {
  const next = emptyRules();
  if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

/**
 * Render a rule bucket for prompt injection. Returns "" when empty so prompts
 * don't grow an empty section header.
 */
export function formatRulesForPrompt(rules: string, heading: string): string {
  const body = rules.trim();
  if (!body) return "";
  return `\n\n${heading}\n${body}`;
}
