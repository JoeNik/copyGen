"use client";

import { useEffect, useRef, useState } from "react";
import { APP_VERSION } from "@/lib/version";
import { CHANGELOG } from "@/lib/changelog";

const REPO_URL = "https://github.com/JoeNik/copyGen";

/**
 * Version badge that opens the changelog (generated from the git log at commit
 * time — see scripts/gen-changelog.cjs).
 */
export default function VersionBadge({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="查看更新记录"
        className={`text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors ${className}`}
      >
        v{APP_VERSION}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="changelog-title"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between gap-4">
              <div>
                <h2 id="changelog-title" className="text-lg font-semibold">更新记录</h2>
                <p className="text-xs text-[var(--color-muted)] mt-0.5">
                  当前版本 v{APP_VERSION} · 共 {CHANGELOG.length} 条提交记录
                </p>
              </div>
              <a
                href={`${REPO_URL}/commits`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--color-primary)] hover:underline flex-shrink-0"
              >
                在 GitHub 查看全部
              </a>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {CHANGELOG.length === 0 ? (
                <p className="text-sm text-[var(--color-muted)]">暂无更新记录。</p>
              ) : (
                <ol className="space-y-4">
                  {CHANGELOG.map((entry) => (
                    <li key={entry.hash} className="border-b border-[var(--color-border)] last:border-0 pb-4 last:pb-0">
                      <div className="flex items-baseline justify-between gap-3 mb-1">
                        <span className="text-sm font-medium break-words">{entry.subject}</span>
                        <span className="text-xs text-[var(--color-muted)] flex-shrink-0">{entry.date}</span>
                      </div>
                      {entry.details.length > 0 && (
                        <ul className="mt-1.5 space-y-1 pl-4">
                          {entry.details.map((line, i) => (
                            <li key={i} className="text-xs text-[var(--color-muted)] list-disc break-words">
                              {line}
                            </li>
                          ))}
                        </ul>
                      )}
                      <a
                        href={`${REPO_URL}/commit/${entry.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block mt-2 text-[10px] font-mono text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors"
                      >
                        {entry.hash}
                      </a>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="px-6 py-4 border-t border-[var(--color-border)] flex justify-end">
              <button
                ref={closeRef}
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
