"use client";

import { useMemo, useState } from "react";
import {
  AI_PROVIDER_PRESETS,
  createCustomProviderDraft,
  getMergedProviderView,
  getProviderPreset,
  removeAIProvider,
  setActiveProviderId,
  upsertAIProvider,
  type AIProtocol,
  type AIProviderConfig,
} from "@/lib/storage";

interface Props {
  onClose: () => void;
  onSaved?: () => void;
}

type EditState = {
  id: string;
  protocol: AIProtocol;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  custom?: boolean;
  isNewCustom?: boolean;
};

export default function AISettingsModal({ onClose, onSaved }: Props) {
  const [tick, setTick] = useState(0);
  const providers = useMemo(() => getMergedProviderView(), [tick]);
  const active = providers.find((p) => p.active) || null;

  const [editing, setEditing] = useState<EditState | null>(null);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = () => setTick((t) => t + 1);

  const openEdit = (p: AIProviderConfig & { isPreset?: boolean }) => {
    setError("");
    setConfirmRemove(null);
    const preset = getProviderPreset(p.id);
    setEditing({
      id: p.id,
      protocol: p.protocol,
      label: p.label,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl || preset?.baseUrl || "",
      model: p.model || preset?.model || "",
      custom: p.custom,
      isNewCustom: false,
    });
  };

  const openNewCustom = () => {
    setError("");
    setConfirmRemove(null);
    const draft = createCustomProviderDraft();
    setEditing({
      ...draft,
      isNewCustom: true,
    });
  };

  const handleEnable = (id: string) => {
    setError("");
    try {
      setActiveProviderId(id);
      refresh();
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "启用失败");
    }
  };

  const handleSaveEdit = (andActivate: boolean) => {
    if (!editing) return;
    setError("");
    if (!editing.apiKey.trim()) {
      setError("请填写 API Key");
      return;
    }
    if (!editing.baseUrl.trim()) {
      setError("请填写 Base URL");
      return;
    }
    if (!editing.model.trim()) {
      setError("请填写模型名称");
      return;
    }
    try {
      upsertAIProvider({
        id: editing.id,
        protocol: editing.protocol,
        label: editing.label,
        apiKey: editing.apiKey,
        baseUrl: editing.baseUrl,
        model: editing.model,
        custom: editing.custom || editing.isNewCustom,
        activate: andActivate,
      });
      setEditing(null);
      refresh();
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  };

  const handleClearKey = (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    upsertAIProvider({
      id: p.id,
      protocol: p.protocol,
      label: p.label,
      apiKey: "",
      baseUrl: p.baseUrl,
      model: p.model,
      custom: p.custom,
    });
    setConfirmRemove(null);
    setEditing(null);
    refresh();
    onSaved?.();
  };

  const handleRemoveCustom = (id: string) => {
    removeAIProvider(id);
    setConfirmRemove(null);
    setEditing(null);
    refresh();
    onSaved?.();
  };

  const protocolLabel = (p: AIProtocol) =>
    p === "openai" ? "OpenAI 兼容" : p === "claude" ? "Claude" : "Gemini";

  const presetHint = editing ? getProviderPreset(editing.id) : undefined;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">AI 提供商</h2>
            <p className="text-xs text-[var(--color-muted)] mt-1">
              可配置多个提供商，但同一时间只能启用一个。配置仅保存在本机浏览器。
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-muted)] hover:text-[var(--color-foreground)] text-sm px-2 py-1"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {active ? (
            <div className="rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 px-3 py-2 text-sm">
              当前启用：
              <span className="font-medium ml-1">{active.label}</span>
              <span className="text-[var(--color-muted)] ml-2 text-xs">
                {active.model} · {protocolLabel(active.protocol)}
              </span>
            </div>
          ) : (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              尚未启用任何提供商，请配置 API Key 后启用其中一个。
            </div>
          )}

          {!editing ? (
            <>
              <div className="space-y-2">
                {providers.map((p) => {
                  const preset = AI_PROVIDER_PRESETS.find((x) => x.id === p.id);
                  return (
                    <div
                      key={p.id}
                      className={`border rounded-xl p-3 transition-colors ${
                        p.active
                          ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
                          : "border-[var(--color-border)] hover:border-[var(--color-muted)]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{p.label}</span>
                            {p.active && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-primary)] text-white">
                                已启用
                              </span>
                            )}
                            {p.configured && !p.active && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-500/20 text-zinc-300">
                                已配置
                              </span>
                            )}
                            {!p.configured && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-500/10 text-zinc-500">
                                未配置
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[var(--color-muted)] mt-1 truncate">
                            {preset?.description || protocolLabel(p.protocol)}
                            {p.configured ? ` · ${p.model}` : ""}
                          </p>
                          {p.configured && (
                            <p className="text-[11px] text-[var(--color-muted)] mt-0.5 truncate opacity-80">
                              {p.baseUrl}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col gap-1.5 shrink-0">
                          <button
                            onClick={() => openEdit(p)}
                            className="text-xs px-2.5 py-1 rounded-md border border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors"
                          >
                            {p.configured ? "编辑" : "配置"}
                          </button>
                          {p.configured && !p.active && (
                            <button
                              onClick={() => handleEnable(p.id)}
                              className="text-xs px-2.5 py-1 rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white transition-colors"
                            >
                              启用
                            </button>
                          )}
                          {p.active && (
                            <button
                              disabled
                              className="text-xs px-2.5 py-1 rounded-md bg-[var(--color-primary)]/40 text-white cursor-default"
                            >
                              使用中
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                onClick={openNewCustom}
                className="w-full py-2.5 border border-dashed border-[var(--color-border)] rounded-xl text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-primary)] transition-colors"
              >
                + 添加自定义 OpenAI 兼容提供商
              </button>
            </>
          ) : (
            <div className="space-y-3">
              <button
                onClick={() => { setEditing(null); setError(""); }}
                className="text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              >
                ← 返回列表
              </button>

              <div>
                <label className="block text-sm text-[var(--color-muted)] mb-1">名称</label>
                <input
                  type="text"
                  value={editing.label}
                  onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                  disabled={!editing.custom && !editing.isNewCustom && !!presetHint}
                  className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] disabled:opacity-60"
                />
              </div>

              {(editing.custom || editing.isNewCustom) && (
                <div>
                  <label className="block text-sm text-[var(--color-muted)] mb-1">协议</label>
                  <select
                    value={editing.protocol}
                    onChange={(e) => setEditing({ ...editing, protocol: e.target.value as AIProtocol })}
                    className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                  >
                    <option value="openai">OpenAI 兼容</option>
                    <option value="claude">Claude</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm text-[var(--color-muted)] mb-1">API Key</label>
                <input
                  type="password"
                  value={editing.apiKey}
                  onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                  placeholder={presetHint?.keyPlaceholder || "sk-xxxx"}
                  className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                  autoComplete="off"
                />
              </div>

              <div>
                <label className="block text-sm text-[var(--color-muted)] mb-1">Base URL</label>
                <input
                  type="text"
                  value={editing.baseUrl}
                  onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                  placeholder={presetHint?.baseUrl || "https://api.example.com"}
                  className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                />
                <p className="text-xs text-[var(--color-muted)] mt-1">不要末尾斜杠；OpenAI 兼容会自动拼接 chat/completions 路径</p>
              </div>

              <div>
                <label className="block text-sm text-[var(--color-muted)] mb-1">模型</label>
                <input
                  type="text"
                  value={editing.model}
                  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                  placeholder={presetHint?.model || "gpt-4o"}
                  className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => handleSaveEdit(false)}
                  className="flex-1 py-2 border border-[var(--color-border)] rounded-lg text-sm hover:border-[var(--color-primary)] transition-colors"
                >
                  仅保存
                </button>
                <button
                  onClick={() => handleSaveEdit(true)}
                  className="flex-1 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg text-sm font-medium transition-colors"
                >
                  保存并启用
                </button>
              </div>

              {providers.some((p) => p.id === editing.id && p.configured) && (
                <div className="pt-2 border-t border-[var(--color-border)]">
                  {confirmRemove === editing.id ? (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-[var(--color-muted)]">确认清除？</span>
                      <button
                        onClick={() =>
                          editing.custom || editing.isNewCustom
                            ? handleRemoveCustom(editing.id)
                            : handleClearKey(editing.id)
                        }
                        className="px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                      >
                        确认
                      </button>
                      <button onClick={() => setConfirmRemove(null)} className="px-2 py-1 text-[var(--color-muted)]">
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmRemove(editing.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      {editing.custom ? "删除此提供商" : "清除 API Key"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {!editing && (
          <div className="px-6 py-4 border-t border-[var(--color-border)]">
            <button
              onClick={onClose}
              className="w-full py-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg text-sm font-medium transition-colors"
            >
              完成
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
