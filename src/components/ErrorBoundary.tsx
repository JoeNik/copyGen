"use client";

import Link from "next/link";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown above the error detail. */
  title?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time crashes so a bad state (or a thrown storage/quota error)
 * shows an actionable message with a way out, instead of React unmounting the
 * tree and leaving the browser's blank "This page couldn't load" screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack in the console for diagnosis; the UI stays readable.
    console.error("页面渲染出错:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex flex-col min-h-screen items-center justify-center px-6 py-12">
        <div className="w-full max-w-lg bg-[var(--color-card)] border border-[var(--color-error)]/30 rounded-xl p-6">
          <h1 className="text-lg font-semibold text-[var(--color-error)] mb-2">
            {this.props.title || "页面出错了"}
          </h1>
          <p className="text-sm text-[var(--color-muted)] mb-4">
            页面渲染时发生错误，已生成的项目数据仍保存在本地，不会丢失。
          </p>
          <pre className="text-xs text-[var(--color-muted)] whitespace-pre-wrap bg-black/20 rounded-lg p-3 border border-[var(--color-border)] mb-5 max-h-40 overflow-auto">
            {error.message || String(error)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 text-sm bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg transition-colors"
            >
              重试
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors"
            >
              刷新页面
            </button>
            <Link
              href="/dashboard"
              className="px-4 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors"
            >
              返回控制台
            </Link>
          </div>
        </div>
      </div>
    );
  }
}
