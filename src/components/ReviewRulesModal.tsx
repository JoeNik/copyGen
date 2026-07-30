"use client";

import { useState } from "react";
import {
  getReviewRules,
  saveReviewRules,
  resetReviewRules,
  DEFAULT_AUDIT_RULES,
  DEFAULT_WRITING_RULES,
  type RuleSource,
} from "@/lib/review-rules";
import { fetchRepoMarkdown, parseRepoRef } from "@/lib/github";
import { distilRulesFromDocs } from "@/lib/ai-helpers";

type Tab = "audit" | "writing";

/**
 * Editor for the user-maintained 软著 rule sets.
 *
 * Two buckets kept apart on purpose: audit rules make the reviewer stricter,
 * writing rules constrain the generator. Merging them made the reviewer flag its
 * own instructions as document content.
 */
export default function ReviewRulesModal({
  accessToken,
  onClose,
}: {
  accessToken?: string;
  onClose: () => void;
}) {
  const initial = getReviewRules();
  const [tab, setTab] = useState<Tab>("audit");
  const [auditRules, setAuditRules] = useState(initial.auditRules);
  const [writingRules, setWritingRules] = useState(initial.writingRules);
  const [sources, setSources] = useState<RuleSource[]>(initial.sources);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Import from a rules repository
  const [repoInput, setRepoInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [pending, setPending] = useState<{
    auditRules: string;
    writingRules: string;
    summary: string;
    source: RuleSource;
  } | null>(null);

  const handleSave = () => {
    try {
      saveReviewRules({ auditRules, writingRules, sources });
      setNotice("规则已保存，下次核对/审核/生成时生效");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  };

  const handleReset = () => {
    const next = resetReviewRules();
    setAuditRules(next.auditRules);
    setWritingRules(next.writingRules);
    setSources([]);
    setPending(null);
    setNotice("已恢复为内置默认规则");
  };

  const handleImport = async () => {
    const ref = parseRepoRef(repoInput);
    if (!ref) {
      setError("请输入 owner/repo 或完整的 GitHub 仓库地址");
      return;
    }
    if (!accessToken) {
      setError("需要 GitHub 授权才能读取仓库，请先登录");
      return;
    }
    setImporting(true);
    setError("");
    setNotice("");
    setPending(null);
    try {
      // Default branch is unknown for an arbitrary repo; try the usual two.
      const branches = ref.branch ? [ref.branch] : ["main", "master"];
      let docs: { path: string; content: string }[] = [];
      let lastErr: unknown;
      for (const branch of branches) {
        try {
          const result = await fetchRepoMarkdown(accessToken, ref.owner, ref.repo, branch, {
            onProgress: setImportStatus,
          });
          docs = result.docs;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!docs.length) throw lastErr instanceof Error ? lastErr : new Error("读取仓库文档失败");

      setImportStatus(`已读取 ${docs.length} 个文档，AI 正在提炼规则...`);
      const distilled = await distilRulesFromDocs(docs);
      setPending({
        ...distilled,
        source: {
          label: `${ref.owner}/${ref.repo}`,
          url: `https://github.com/${ref.owner}/${ref.repo}`,
          addedAt: new Date().toISOString(),
        },
      });
      setImportStatus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
      setImportStatus("");
    } finally {
      setImporting(false);
    }
  };

  /** Merge or replace — merging keeps hand-written rules that the import doesn't cover. */
  const applyPending = (mode: "merge" | "replace") => {
    if (!pending) return;
    const join = (existing: string, incoming: string) => {
      if (!incoming.trim()) return existing;
      if (mode === "replace") return incoming;
      if (!existing.trim()) return incoming;
      return `${existing.trim()}\n\n# 来自 ${pending.source.label}\n${incoming.trim()}`;
    };
    setAuditRules((prev) => join(prev, pending.auditRules));
    setWritingRules((prev) => join(prev, pending.writingRules));
    setSources((prev) => [...prev.filter((s) => s.url !== pending.source.url), pending.source]);
    setPending(null);
    setNotice(`已${mode === "merge" ? "合并" : "替换"}来自 ${pending.source.label} 的规则，记得点「保存规则」`);
  };

  const activeValue = tab === "audit" ? auditRules : writingRules;
  const setActiveValue = tab === "audit" ? setAuditRules : setWritingRules;
  const activeDefault = tab === "audit" ? DEFAULT_AUDIT_RULES : DEFAULT_WRITING_RULES;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-lg font-semibold">软著审核规则</h2>
          <p className="text-xs text-[var(--color-muted)] mt-1">
            这里的内容会追加到 AI 核对、审核说明书和文档生成的提示词里。可以手动编辑，也可以从一个专门收集软著规则的
            GitHub 仓库导入。
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded-lg p-3 text-xs text-[var(--color-error)]">
              {error}
            </div>
          )}
          {notice && (
            <div className="bg-[var(--color-success)]/10 border border-[var(--color-success)]/20 rounded-lg p-3 text-xs text-[var(--color-success)]">
              {notice}
            </div>
          )}

          {/* Import from a rules repository */}
          <div className="border border-[var(--color-border)] rounded-lg p-4 space-y-2">
            <div className="text-sm font-medium">从规则仓库导入</div>
            <p className="text-xs text-[var(--color-muted)]">
              读取该仓库中的 Markdown 文档，由 AI 提炼成可检查的规则条目。适合导入别人整理的软著申报经验、审查要点、驳回原因汇总。
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                placeholder="owner/repo 或 https://github.com/owner/repo"
                className="flex-1 px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
              />
              <button
                onClick={handleImport}
                disabled={importing || !repoInput.trim()}
                className="px-3 py-2 text-sm bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {importing ? "导入中..." : "读取并提炼"}
              </button>
            </div>
            {importStatus && <p className="text-xs text-[var(--color-primary)]">{importStatus}</p>}

            {pending && (
              <div className="border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 rounded-lg p-3 space-y-2">
                <div className="text-xs font-medium">提炼结果预览 · {pending.source.label}</div>
                {pending.summary && <p className="text-xs text-[var(--color-muted)]">{pending.summary}</p>}
                <details className="text-xs">
                  <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
                    审核规则（{pending.auditRules.split("\n").filter(Boolean).length} 条）
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap bg-[var(--color-input-bg)] rounded p-2 text-[10px] leading-relaxed">
                    {pending.auditRules || "（无）"}
                  </pre>
                </details>
                <details className="text-xs">
                  <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
                    撰写要求（{pending.writingRules.split("\n").filter(Boolean).length} 条）
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap bg-[var(--color-input-bg)] rounded p-2 text-[10px] leading-relaxed">
                    {pending.writingRules || "（无）"}
                  </pre>
                </details>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => applyPending("merge")}
                    className="px-2 py-1 text-xs bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded transition-colors"
                  >
                    合并到现有规则
                  </button>
                  <button
                    onClick={() => applyPending("replace")}
                    className="px-2 py-1 text-xs border border-[var(--color-border)] rounded text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors"
                  >
                    替换现有规则
                  </button>
                  <button
                    onClick={() => setPending(null)}
                    className="px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors"
                  >
                    放弃
                  </button>
                </div>
              </div>
            )}

            {sources.length > 0 && (
              <div className="text-xs text-[var(--color-muted)]">
                已导入来源：
                {sources.map((s, i) => (
                  <span key={s.url}>
                    {i > 0 && "、"}
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[var(--color-primary)] hover:underline">
                      {s.label}
                    </a>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Rule editor */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => setTab("audit")}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                  tab === "audit"
                    ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                    : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-muted)]"
                }`}
              >
                审核规则
              </button>
              <button
                onClick={() => setTab("writing")}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                  tab === "writing"
                    ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                    : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-muted)]"
                }`}
              >
                撰写要求
              </button>
              <button
                onClick={() => setActiveValue(activeDefault)}
                className="ml-auto text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:underline"
              >
                恢复本页默认
              </button>
            </div>
            <p className="text-xs text-[var(--color-muted)] mb-2">
              {tab === "audit"
                ? "用于「AI 核对」和「审核说明书」——每条应是能判定符合与否的检查项。"
                : "用于生成和修订说明书——每条应是可执行的写作要求。"}
            </p>
            <textarea
              value={activeValue}
              onChange={(e) => setActiveValue(e.target.value)}
              rows={16}
              placeholder="每行一条，以「- 」开头"
              className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-xs font-mono leading-relaxed focus:outline-none focus:border-[var(--color-primary)]"
            />
            <p className="text-xs text-[var(--color-muted)] mt-1">
              {activeValue.split("\n").filter((l) => l.trim().startsWith("-")).length} 条规则 ·
              {" "}{activeValue.length} 字符（过长会占用提示词空间，建议控制在 3000 字符内）
            </p>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[var(--color-border)] flex flex-wrap gap-2">
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg transition-colors"
          >
            保存规则
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors"
          >
            关闭
          </button>
          <button
            onClick={handleReset}
            className="ml-auto px-4 py-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-error)] transition-colors"
          >
            全部恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}
