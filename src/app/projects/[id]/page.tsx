"use client";
import Logo from "@/components/Logo";
import ConfirmDialog from "@/components/ConfirmDialog";
import ErrorBoundary from "@/components/ErrorBoundary";
import VersionBadge from "@/components/VersionBadge";


import { useSession } from "next-auth/react";
import { SessionProvider } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { getProject, updateProject, getAIKey, getManualDraft, saveManualDraft, clearManualDraft, type Project, type SoftwareMeta, type ManualDraft } from "@/lib/storage";
import { fetchRepoBranches, fetchRepoFiles, fetchRepoStats, fetchRepoLanguages, fetchRepoInsights, fetchRepo, type GitHubBranch } from "@/lib/github";
import { generateManualMarkdown, callAIForText, generateProjectMetadata, sanitizeSoftCopyrightText, reviewProjectMeta, auditManualMarkdown, buildTechCategoriesFromInsightsPrompt, type MetaReviewResult, type ManualAuditResult } from "@/lib/ai-helpers";
import { generateCodePDF } from "@/lib/docgen/code-pdf";
import { generateManualPDF } from "@/lib/docgen/manual-pdf";
import { parseUserAgent, detectDevTools, mapLinguistToGivenLanguages, describeLanguageStats, GIVEN_LANGUAGES, GIVEN_TECH_CATEGORIES, SOFTWARE_CATEGORIES } from "@/lib/utils";
import {
  startRun,
  subscribeToRun,
  getRun,
  isRunning,
  takeFinishedRun,
  forgetRun,
  type GenerationResult,
} from "@/lib/generation-runtime";

const steps = ["读取仓库代码", "分析代码结构", "AI 生成元数据", "生成程序鉴别材料", "生成文档鉴别材料", "完成"];

/** Chinese labels for metadata keys, used in 核对 messages. */
const META_FIELD_LABELS_UI: Record<string, string> = {
  softwareName: "软件全称",
  version: "版本号",
  category: "软件分类",
  purpose: "开发目的",
  domain: "面向领域/行业",
  mainFeatures: "主要功能",
  technicalFeatures: "技术特点",
  softwareDescription: "软件说明",
  runPlatform: "运行平台",
  runSupport: "运行支撑环境",
  devTools: "开发工具",
  devHardware: "开发硬件环境",
  runHardware: "运行硬件环境",
  devOS: "开发操作系统",
  languagesGiven: "编程语言（给定项）",
  languagesExtra: "编程语言（补充项）",
  techCategoriesGiven: "技术特点分类",
  techCategoriesExtra: "技术特点（补充）",
  sourceLines: "源程序行数",
};

/**
 * Mark a project as interrupted so reopen shows resume UI instead of stuck "准备中".
 *
 * Only call this when the run is genuinely gone (tab closed / reloaded). An SPA
 * navigation does NOT end the run — see `generation-runtime`.
 */
function markGenerationInterrupted(projectId: string): { project: Project; draft: ManualDraft | null; message: string } | null {
  const p = getProject(projectId);
  if (!p || p.status !== "PROCESSING") return null;
  const draft = getManualDraft(projectId);
  const message = draft?.markdown
    ? `生成过程被中断（页面关闭或刷新）。已保存说明书草稿 ${draft.lines || 0} 行，可从断点继续。`
    : "生成过程被中断（页面关闭或刷新）。请重新生成。";
  updateProject(projectId, { status: "FAILED", errorMsg: message });
  const updated = getProject(projectId);
  if (!updated) return null;
  return { project: updated, draft, message };
}

function describeManualDraftResume(draft: ManualDraft): string {
  const nextChapter = draft.nextChapterIndex == null ? null : draft.nextChapterIndex + 1;
  const chapterText = nextChapter ? `，将从第 ${nextChapter} 章起继续` : "";
  return `已保存 ${draft.lines || 0} 行文档草稿${chapterText}，更新时间 ${new Date(draft.updatedAt).toLocaleString("zh-CN")}。`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sync software name / version edits into already-generated manual markdown so the
 * document text stays consistent with project basics — no full regeneration needed.
 * Literal, whole-string replacement of the old values; skips no-op / empty changes.
 */
function syncManualMarkdownFields(
  markdown: string,
  changes: { oldName: string; newName: string; oldVersion: string; newVersion: string }
): string {
  let next = markdown;
  const { oldName, newName, oldVersion, newVersion } = changes;
  // Version first: older names may contain the version, replace the more specific token first.
  if (oldVersion && newVersion && oldVersion !== newVersion) {
    next = next.replace(new RegExp(escapeRegExp(oldVersion), "g"), newVersion);
  }
  if (oldName && newName && oldName !== newName) {
    next = next.replace(new RegExp(escapeRegExp(oldName), "g"), newName);
  }
  return next;
}

function ProjectDetailContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams();
  const projectId = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [meta, setMeta] = useState<SoftwareMeta | null>(null);
  const [generating, setGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState("");
  const [progress, setProgress] = useState(0);
  const [stepIndex, setStepIndex] = useState(-1);
  const [error, setError] = useState("");
  const [metaReady, setMetaReady] = useState(false);
  const [detectStatus, setDetectStatus] = useState("");
  const [codePdfUrl, setCodePdfUrl] = useState<string | null>(null);
  const [manualPdfUrl, setManualPdfUrl] = useState<string | null>(null);
  const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null);
  const [manualMarkdown, setManualMarkdown] = useState("");
  const [editingManual, setEditingManual] = useState(false);
  const [reexporting, setReexporting] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState({ softwareName: "", version: "", completedAt: "", branch: "", repoDescription: "" });
  /** Full metadata copy edited inside 「编辑项目」 so creation-time values are correctable. */
  const [metaDraft, setMetaDraft] = useState<SoftwareMeta | null>(null);
  const [forceRegenerate, setForceRegenerate] = useState(false);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchesLoadAttempted, setBranchesLoadAttempted] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [refreshingRepoDesc, setRefreshingRepoDesc] = useState(false);

  // AI 核对项目信息 / 审核说明书
  const [metaReview, setMetaReview] = useState<MetaReviewResult | null>(null);
  const [reviewingMeta, setReviewingMeta] = useState(false);
  const [metaReviewError, setMetaReviewError] = useState("");
  const [appliedIssues, setAppliedIssues] = useState<Record<string, boolean>>({});
  /** Editable copies of AI suggestions, keyed by "index:field". */
  const [suggestionDrafts, setSuggestionDrafts] = useState<Record<string, string>>({});
  const [editingSuggestion, setEditingSuggestion] = useState<Record<string, boolean>>({});
  const [manualAudit, setManualAudit] = useState<ManualAuditResult | null>(null);
  const [auditingManual, setAuditingManual] = useState(false);
  const [auditError, setAuditError] = useState("");

  /** Pending action awaiting二次确认 (guards misclicks during/after generation). */
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    destructive?: boolean;
    run: () => void;
  } | null>(null);

  const accessToken = (session as { accessToken?: string })?.accessToken;

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    if (session && !getAIKey()) router.push("/");
  }, [status, session, router]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const loadProject = async () => {
      await Promise.resolve();
      if (!active) return;
      const p = getProject(projectId);
      if (!p) { router.push("/dashboard"); return; }

      const liveRun = getRun(projectId);

      // A PROCESSING project with no live run in this tab means the run really is
      // gone (tab was closed or reloaded) — recover to FAILED so the resume UI
      // shows instead of an endless "准备中...". If a run IS live, leave the status
      // alone and re-attach below; the work is still progressing.
      if (p.status === "PROCESSING" && !liveRun) {
        const recovered = markGenerationInterrupted(projectId);
        if (recovered) {
          setProject(recovered.project);
          setMeta(recovered.project.meta);
          setBranches([]);
          setBranchesLoadAttempted(false);
          setProjectDraft({
            softwareName: recovered.project.softwareName,
            version: recovered.project.version,
            completedAt: recovered.project.completedAt || "",
            branch: recovered.project.defaultBranch,
            repoDescription: recovered.project.repoDescription || "",
          });
          setManualDraft(recovered.draft);
          if (recovered.project.manualMarkdown) setManualMarkdown(recovered.project.manualMarkdown);
          setError(recovered.message);
          setMetaReady(true);
          return;
        }
      }

      setProject(p);
      setMeta(p.meta);
      setBranches([]);
      setBranchesLoadAttempted(false);
      setProjectDraft({
        softwareName: p.softwareName,
        version: p.version,
        completedAt: p.completedAt || "",
        branch: p.defaultBranch,
        repoDescription: p.repoDescription || "",
      });
      setManualDraft(getManualDraft(projectId));
      if (p.manualMarkdown) setManualMarkdown(p.manualMarkdown);
      // Re-attach to a run that survived navigation: restore its live progress
      // rather than showing a stale/idle view.
      if (liveRun?.status === "running") {
        setGenerating(true);
        setStepIndex(liveRun.progress.stepIndex);
        setProgress(liveRun.progress.progress);
        setCurrentStep(liveRun.progress.currentStep);
        setMetaReady(true);
      } else if (p.status === "DONE" || p.status === "FAILED") {
        // DONE / FAILED already have meta; skip auto-detect spinner on reopen
        setMetaReady(true);
      }
    };
    void loadProject();
    return () => { active = false; };
  }, [projectId, session, router]);

  // Only a real page teardown (close / reload) kills the run. SPA unmount does
  // not — the promise lives in `generation-runtime`, so no recovery on unmount.
  useEffect(() => {
    const onLeave = () => {
      if (!isRunning(projectId)) return;
      markGenerationInterrupted(projectId);
    };
    // Native browser prompt is the only thing that can stop a reload/close; the
    // in-app dialog cannot intercept it. Do NOT mark interrupted here — the user
    // may cancel the unload and generation continues. `pagehide` fires only when
    // the page is actually going away, so recovery is recorded there.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isRunning(projectId)) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [projectId]);

  // Auto-detect metadata on first visit
  useEffect(() => {
    if (!project || !accessToken || metaReady) return;

    const detectMeta = async () => {
      const { os, cores, memory } = parseUserAgent();
      // Accumulate detected values locally so persistence never relies on a side
      // effect inside a state updater (StrictMode invokes updaters twice).
      let next: SoftwareMeta = {
        ...project.meta,
        devHardware: `PC, ${os}, ${cores}核CPU, ${memory}GB内存`,
        runHardware: `PC, ${os}, ${cores}核CPU, ${memory}GB内存`,
        devOS: os,
      };
      setMeta(next);

      if (!project.defaultBranch.trim()) {
        setError("项目未指定代码分支，请重新创建项目并选择分支");
        setMetaReady(true);
        return;
      }

      try {
        setDetectStatus("正在读取仓库文件树...");
        const { allFilePaths, estimatedLines } = await fetchRepoStats(
          accessToken, project.repoOwner, project.repoName, project.defaultBranch
        );

        const devTools = detectDevTools(allFilePaths);

        // Backfill the repo description for projects created before it was stored.
        let repoDescription = project.repoDescription || "";
        if (!repoDescription) {
          try {
            const repoInfo = await fetchRepo(accessToken, project.repoOwner, project.repoName);
            repoDescription = repoInfo.description || "";
            if (repoDescription) updateProject(projectId, { repoDescription });
          } catch { /* description is optional context */ }
        }

        // GitHub Linguist byte-weighted stats beat extension counting: it ignores
        // vendored/generated files and reflects real code volume.
        setDetectStatus("正在获取语言统计...");
        const langStats = await fetchRepoLanguages(accessToken, project.repoOwner, project.repoName);
        const givenLangs = mapLinguistToGivenLanguages(langStats);
        const languageStatsText = describeLanguageStats(langStats);

        next = {
          ...next,
          devTools,
          languagesGiven: givenLangs.length ? givenLangs : next.languagesGiven,
          sourceLines: estimatedLines,
        };
        setMeta(next);

        // README + manifests + module layout — this is what makes 开发目的/主要功能
        // specific rather than boilerplate.
        setDetectStatus("正在读取 README 与依赖清单...");
        const insights = await fetchRepoInsights(
          accessToken, project.repoOwner, project.repoName, project.defaultBranch, allFilePaths
        );

        // Persist context immediately so 「AI 核对」 works before any generation run.
        updateProject(projectId, {
          reviewContext: {
            fileTree: insights.sourcePaths.slice(0, 60).join("\n"),
            languages: languageStatsText || givenLangs.join(", "),
            codeSummary: insights.manifests
              .map((m) => `--- ${m.path} ---\n${m.content.slice(0, 1200)}`)
              .join("\n\n"),
            readme: insights.readme.slice(0, 4000),
            moduleDirs: insights.moduleDirs.join("\n").slice(0, 2000),
          },
        });

        setDetectStatus("AI 正在分析项目用途与功能...");
        const generated = await generateProjectMetadata({
          repoName: project.repoName,
          repoDescription,
          languageStats: languageStatsText,
          givenLanguages: givenLangs.join("、"),
          readme: insights.readme,
          manifests: insights.manifests,
          moduleDirs: insights.moduleDirs,
          sourcePaths: insights.sourcePaths,
          devTools,
        });

        if (generated) {
          next = {
            ...next,
            runPlatform: generated.runPlatform || next.runPlatform,
            runSupport: generated.runSupport || next.runSupport,
            purpose: generated.purpose || next.purpose,
            domain: generated.domain || next.domain,
            mainFeatures: generated.mainFeatures || next.mainFeatures,
            technicalFeatures: generated.technicalFeatures || next.technicalFeatures,
            softwareDescription: generated.softwareDescription || next.softwareDescription,
          };
          setMeta(next);
          setDetectStatus("");
        } else {
          setDetectStatus("AI 未返回可解析的元数据，请手动填写或点「AI 核对」重试");
        }

        // Tech categories from real evidence, only if not already chosen.
        if (!next.techCategoriesGiven?.length) {
          try {
            const catText = await callAIForText(
              buildTechCategoriesFromInsightsPrompt({
                repoName: project.repoName,
                repoDescription,
                readme: insights.readme,
                moduleDirs: insights.moduleDirs,
                languageStats: languageStatsText,
              }),
              300
            );
            const cats = catText.split(/[,，]/).map((s) => s.trim()).filter((s) => GIVEN_TECH_CATEGORIES.includes(s));
            if (cats.length) {
              next = { ...next, techCategoriesGiven: cats };
              setMeta(next);
            }
          } catch { /* keep whatever was set at creation */ }
        }

        updateProject(projectId, { meta: next });
        setProject(getProject(projectId)!);
      } catch (e) {
        setDetectStatus(
          e instanceof Error ? `自动检测失败：${e.message}` : "自动检测失败，请手动填写信息"
        );
      }

      setMetaReady(true);
    };

    detectMeta();
  }, [project, accessToken, projectId, metaReady]);

  const startGenerate = useCallback((opts?: { resumeManual?: boolean; freshManual?: boolean }) => {
    if (!project || !accessToken || !meta) return;
    if (!project.defaultBranch.trim()) {
      setError("项目未指定代码分支，请重新创建项目并选择分支");
      return;
    }
    // A run already in flight owns the draft — never start a second writer.
    if (isRunning(projectId)) {
      setError("该项目的生成任务正在进行中，请等待完成。");
      return;
    }

    const resumeManual = !!opts?.resumeManual;
    if (opts?.freshManual) {
      clearManualDraft(projectId);
      setManualDraft(null);
    }

    setGenerating(true);
    setError("");
    setStepIndex(-1);
    setProgress(0);
    setCurrentStep("准备中...");
    // Save meta before generating
    updateProject(projectId, { status: "PROCESSING", meta });
    setProject(getProject(projectId)!);

    // Snapshot everything the task needs: it must not read component state, since
    // it keeps running after this component unmounts.
    const token = accessToken;
    const snapshot = {
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      branch: project.defaultBranch,
      softwareName: project.softwareName,
      version: project.version,
      repoDescription: project.repoDescription || "",
      meta,
    };

    startRun(projectId, async (emit): Promise<GenerationResult> => {
      // Step 0: Fetch files
      emit({ stepIndex: 0, currentStep: "正在读取仓库代码...", progress: 5 });
      const { files, languages: langExts, totalSourceLines, readFileCount, codeFileCount } = await fetchRepoFiles(
        token, snapshot.repoOwner, snapshot.repoName, snapshot.branch,
        (msg, pct) => emit({ currentStep: msg, progress: pct })
      );

      // Step 1: Analyze
      emit({ stepIndex: 1, currentStep: "正在分析代码结构...", progress: 25 });
      const languageStr = langExts.slice(0, 10).join(", ");
      const fileTree = files.slice(0, 50).map((f) => f.path).join("\n");
      const codeSummary = files.slice(0, 10).map((f) => `// ${f.path}\n${f.content.slice(0, 500)}`).join("\n\n").slice(0, 4000);
      if (codeFileCount > readFileCount) {
        emit({
          currentStep: `代码文件 ${codeFileCount} 个，已下载 ${readFileCount} 个；源程序量按仓库整体估算为 ${totalSourceLines} 行`,
        });
      }

      // Persist richer repo snapshot for AI 核对/审核 after page refresh, keeping
      // the README/moduleDirs captured during auto-detection.
      const existingCtx = getProject(projectId)?.reviewContext;
      updateProject(projectId, {
        reviewContext: {
          fileTree,
          languages: existingCtx?.languages || languageStr,
          codeSummary,
          readme: existingCtx?.readme,
          moduleDirs: existingCtx?.moduleDirs,
        },
      });

      // Step 2: AI metadata (already done in detectMeta, just confirm)
      emit({ stepIndex: 2, currentStep: "正在确认元数据...", progress: 30 });

      // Step 3: Generate code PDF (程序鉴别材料)
      emit({ stepIndex: 3, currentStep: "正在生成程序鉴别材料 PDF...", progress: 35 });
      const codePDFBlob = await generateCodePDF(
        snapshot.softwareName, snapshot.version, files,
        (msg) => emit({ currentStep: msg })
      );

      // Step 4: Generate manual PDF (文档鉴别材料)
      const existingDraft = getManualDraft(projectId);
      emit({
        stepIndex: 4,
        progress: 50,
        currentStep: resumeManual || existingDraft?.markdown
          ? "正在从断点接续生成文档鉴别材料..."
          : "正在按章节生成文档鉴别材料...",
      });

      const generatedMarkdown = await generateManualMarkdown(
        snapshot.softwareName, snapshot.version, snapshot.meta,
        snapshot.repoDescription, languageStr, fileTree, codeSummary,
        {
          projectId,
          resumeMarkdown: resumeManual || existingDraft?.markdown ? existingDraft?.markdown : undefined,
          resumeAttempt: existingDraft?.attempt,
          resumeChapterIndex: existingDraft?.nextChapterIndex,
          onProgress: (msg) => emit({ currentStep: msg }),
        }
      );

      emit({ currentStep: "正在排版文档鉴别材料 PDF...", progress: 70 });
      const manualPDFBlob = await generateManualPDF(
        snapshot.softwareName, snapshot.version, "软件著作权人", generatedMarkdown,
        (msg) => emit({ currentStep: msg })
      );

      // Step 5: Done — persist here so the result survives even if no page is mounted.
      emit({ stepIndex: 5, currentStep: "生成完成！", progress: 100 });
      clearManualDraft(projectId);
      // Persisting the manual can hit the localStorage quota. The PDFs are already
      // rendered at this point, so report the save problem without discarding them —
      // the user can still download the materials from this session.
      try {
        updateProject(projectId, {
          status: "DONE",
          meta: { ...snapshot.meta, sourceLines: totalSourceLines },
          errorMsg: undefined,
          manualMarkdown: generatedMarkdown,
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        updateProject(projectId, {
          status: "DONE",
          meta: { ...snapshot.meta, sourceLines: totalSourceLines },
          errorMsg: `材料已生成，但说明书文稿未能保存到本地存储：${detail}`,
        });
      }

      return {
        markdown: generatedMarkdown,
        codePdf: codePDFBlob,
        manualPdf: manualPDFBlob,
        sourceLines: totalSourceLines,
      };
    });
  }, [project, projectId, accessToken, meta]);

  // Mirror the live run into component state: progress while running, and the
  // final result (or error) once it settles — even if it settled while this page
  // was unmounted.
  useEffect(() => {
    const sync = () => {
      const run = getRun(projectId);
      if (!run) return;

      if (run.status === "running") {
        setGenerating(true);
        setStepIndex(run.progress.stepIndex);
        setProgress(run.progress.progress);
        setCurrentStep(run.progress.currentStep);
        const draft = getManualDraft(projectId);
        if (draft) setManualDraft(draft);
        return;
      }

      const finished = takeFinishedRun(projectId);
      if (!finished) return;
      setGenerating(false);

      if (finished.error) {
        setError(finished.error);
        setManualDraft(getManualDraft(projectId));
        try {
          updateProject(projectId, { status: "FAILED", errorMsg: finished.error });
        } catch { /* storage full — the in-memory error is still shown */ }
        setProject(getProject(projectId) ?? null);
        return;
      }

      const result = finished.result;
      if (!result) return;
      setStepIndex(5);
      setProgress(100);
      setCurrentStep("生成完成！");
      setManualMarkdown(result.markdown);
      setManualDraft(null);
      const saved = getProject(projectId);
      if (saved) {
        setProject(saved);
        setMeta(saved.meta);
      }
      // Creating object URLs can throw if the blob was released; never let that
      // escape into the render path and blank the page.
      try {
        setCodePdfUrl(URL.createObjectURL(result.codePdf));
        setManualPdfUrl(URL.createObjectURL(result.manualPdf));
      } catch (e) {
        setError(
          `材料已生成，但预览链接创建失败：${e instanceof Error ? e.message : String(e)}。请点「重新导出 PDF」。`
        );
      }
    };

    const unsubscribe = subscribeToRun(projectId, sync);
    sync();
    return unsubscribe;
  }, [projectId]);

  const handleDownload = (url: string | null, filename: string) => {
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  };

  /**
   * Route an action through a confirmation dialog. Used for anything that would
   * abort a running generation or throw away generated material — a misclick on
   * those used to silently restart or wipe a half-finished run.
   */
  const requestConfirm = useCallback(
    (opts: { title: string; message: string; confirmLabel: string; destructive?: boolean; run: () => void }) => {
      setPendingConfirm(opts);
    },
    []
  );

  /** Confirm-guarded generate: every entry point asks first, so a stray click can't start or restart a run. */
  const confirmStartGenerate = useCallback(
    (
      opts: { resumeManual?: boolean; freshManual?: boolean } | undefined,
      prompt: { title: string; message: string; confirmLabel: string; destructive?: boolean }
    ) => {
      requestConfirm({ ...prompt, run: () => startGenerate(opts) });
    },
    [requestConfirm, startGenerate]
  );

  const handleDownloadMarkdown = () => {
    const md = manualMarkdown || project?.manualMarkdown || "";
    if (!md) return;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    handleDownload(url, `${project!.softwareName}_操作说明书.md`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleSaveManualEdit = () => {
    if (!project) return;
    updateProject(projectId, { manualMarkdown });
    setProject(getProject(projectId)!);
    setEditingManual(false);
  };

  const startEditProject = () => {
    if (!project) return;
    setProjectDraft({
      softwareName: project.softwareName,
      version: project.version,
      completedAt: project.completedAt || "",
      branch: project.defaultBranch,
      repoDescription: project.repoDescription || "",
    });
    setMetaDraft({ ...project.meta });
    setForceRegenerate(false);
    setEditingProject(true);
    setError("");

    // Load branch list once per edit session so the select shows real options.
    if (accessToken && !branchesLoadAttempted) {
      setBranchesLoadAttempted(true);
      setLoadingBranches(true);
      fetchRepoBranches(accessToken, project.repoOwner, project.repoName)
        .then((data) => {
          setBranches(data);
          setLoadingBranches(false);
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : "获取仓库分支列表失败，请手动填写分支名");
          setLoadingBranches(false);
        });
    }

    // Backfill the description from GitHub when the project predates the field.
    if (accessToken && !project.repoDescription) {
      void (async () => {
        try {
          const info = await fetchRepo(accessToken, project.repoOwner, project.repoName);
          const desc = info.description || "";
          if (!desc) return;
          updateProject(projectId, { repoDescription: desc });
          setProject(getProject(projectId)!);
          // Only fill the field if the user hasn't typed into it meanwhile.
          setProjectDraft((prev) => (prev.repoDescription ? prev : { ...prev, repoDescription: desc }));
        } catch { /* description is optional */ }
      })();
    }
  };

  /** Pull the current description from GitHub on demand (button in the edit form). */
  const handleRefreshRepoDescription = async () => {
    if (!project || !accessToken) return;
    setRefreshingRepoDesc(true);
    setError("");
    try {
      const info = await fetchRepo(accessToken, project.repoOwner, project.repoName);
      const desc = info.description || "";
      setProjectDraft((prev) => ({ ...prev, repoDescription: desc }));
      if (!desc) setError("该仓库在 GitHub 上没有填写描述");
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取仓库描述失败");
    } finally {
      setRefreshingRepoDesc(false);
    }
  };

  const handleSaveProjectEdit = () => {
    if (!project || !meta) return;
    const softwareName = projectDraft.softwareName.trim();
    const version = projectDraft.version.trim();
    const branch = projectDraft.branch.trim();
    if (!softwareName || !version || !branch) {
      setError("软件全称、版本号和代码分支不能为空");
      return;
    }

    const branchChanged = branch !== project.defaultBranch;
    const willClear = branchChanged || forceRegenerate;
    const hasMaterial = !!(project.manualMarkdown || manualDraft?.markdown);

    // Saving with a branch change or 强制清空 discards generated material — confirm
    // before doing it rather than silently wiping a finished document.
    if (willClear && hasMaterial) {
      requestConfirm({
        title: branchChanged ? "切换分支并清空已生成材料？" : "清空已生成材料？",
        message: branchChanged
          ? "切换代码分支后，已生成的说明书文稿和 PDF 将被清除，无法恢复，需要重新检测并生成。"
          : "已勾选「清空已生成的材料」。保存后说明书文稿和 PDF 将被清除，无法恢复。",
        confirmLabel: "确认保存",
        destructive: true,
        run: () => applyProjectEdit({ softwareName, version, branch, branchChanged }),
      });
      return;
    }

    applyProjectEdit({ softwareName, version, branch, branchChanged });
  };

  const applyProjectEdit = ({
    softwareName,
    version,
    branch,
    branchChanged,
  }: { softwareName: string; version: string; branch: string; branchChanged: boolean }) => {
    if (!project || !meta) return;
    setSavingProject(true);
    const nameChanged = softwareName !== project.softwareName;
    const versionChanged = version !== project.version;
    // Metadata edited in the form takes precedence over the live copy.
    const editedMeta: SoftwareMeta = metaDraft ? { ...metaDraft } : meta;

    // Branch change OR user explicitly checked "force regenerate" means the
    // generated materials no longer apply and must be cleared. Auto-detected
    // fields are reset so detection re-runs; user-entered descriptive fields
    // from the edit form are preserved.
    if (branchChanged || forceRegenerate) {
      const resetMeta: SoftwareMeta = {
        ...editedMeta,
        sourceLines: 0,
        devTools: "",
        languagesGiven: branchChanged ? [] : editedMeta.languagesGiven,
      };
      forgetRun(projectId);
      clearManualDraft(projectId);
      setManualDraft(null);
      setManualMarkdown("");
      setCodePdfUrl(null);
      setManualPdfUrl(null);
      setMetaReady(false);
      setMetaReview(null);
      setManualAudit(null);

      updateProject(projectId, {
        softwareName,
        version,
        completedAt: projectDraft.completedAt,
        defaultBranch: branch,
        repoDescription: projectDraft.repoDescription.trim(),
        meta: resetMeta,
        status: "PENDING",
        errorMsg: undefined,
        manualMarkdown: undefined,
        reviewContext: branchChanged ? undefined : project.reviewContext,
      });
    } else {
      // Keep the generated document; sync renamed software name / version into it.
      const fieldsChanged = nameChanged || versionChanged;
      const syncFields = {
        oldName: project.softwareName,
        newName: softwareName,
        oldVersion: project.version,
        newVersion: version,
      };

      let nextManualMarkdown = project.manualMarkdown;
      if (fieldsChanged && project.manualMarkdown) {
        nextManualMarkdown = syncManualMarkdownFields(project.manualMarkdown, syncFields);
        setManualMarkdown(nextManualMarkdown);
      }

      if (fieldsChanged) {
        const draft = getManualDraft(projectId);
        if (draft?.markdown) {
          const syncedDraft: ManualDraft = {
            ...draft,
            softwareName,
            version,
            markdown: syncManualMarkdownFields(draft.markdown, syncFields),
          };
          saveManualDraft(syncedDraft);
          setManualDraft(syncedDraft);
        }
        // In-memory PDFs were rendered with the old name/version → invalidate so
        // the user re-exports to keep the file content consistent.
        if (codePdfUrl) { URL.revokeObjectURL(codePdfUrl); setCodePdfUrl(null); }
        if (manualPdfUrl) { URL.revokeObjectURL(manualPdfUrl); setManualPdfUrl(null); }
      }

      updateProject(projectId, {
        softwareName,
        version,
        completedAt: projectDraft.completedAt,
        defaultBranch: branch,
        repoDescription: projectDraft.repoDescription.trim(),
        meta: editedMeta,
        errorMsg: undefined,
        manualMarkdown: nextManualMarkdown,
      });
    }

    const updated = getProject(projectId)!;
    setProject(updated);
    setMeta(updated.meta);
    setProjectDraft({
      softwareName: updated.softwareName,
      version: updated.version,
      completedAt: updated.completedAt || "",
      branch: updated.defaultBranch,
      repoDescription: updated.repoDescription || "",
    });
    setMetaDraft(null);
    setError("");
    setEditingProject(false);
    setSavingProject(false);
  };

  const handleReviewMeta = async () => {
    if (!project || !meta) return;
    setReviewingMeta(true);
    setMetaReviewError("");
    setMetaReview(null);
    try {
      // Fetch context on demand if auto-detection never stored it (older projects,
      // or detection failed) — 核对 should not depend on a prior generation run.
      let ctx = project.reviewContext;
      if (!ctx?.fileTree) {
        if (!accessToken) throw new Error("GitHub 授权已失效，请重新登录后再核对");
        if (!project.defaultBranch.trim()) throw new Error("项目未指定代码分支");
        setMetaReviewError("正在补取仓库信息...");
        const { allFilePaths } = await fetchRepoStats(
          accessToken, project.repoOwner, project.repoName, project.defaultBranch
        );
        const langStats = await fetchRepoLanguages(accessToken, project.repoOwner, project.repoName);
        const insights = await fetchRepoInsights(
          accessToken, project.repoOwner, project.repoName, project.defaultBranch, allFilePaths
        );
        ctx = {
          fileTree: insights.sourcePaths.slice(0, 60).join("\n"),
          languages: describeLanguageStats(langStats),
          codeSummary: insights.manifests
            .map((m) => `--- ${m.path} ---\n${m.content.slice(0, 1200)}`)
            .join("\n\n"),
          readme: insights.readme.slice(0, 4000),
          moduleDirs: insights.moduleDirs.join("\n").slice(0, 2000),
        };
        updateProject(projectId, { reviewContext: ctx });
        setProject(getProject(projectId)!);
        setMetaReviewError("");
      }

      const result = await reviewProjectMeta({
        softwareName: project.softwareName,
        version: project.version,
        repoName: project.repoName,
        repoDescription: project.repoDescription || "",
        languages: ctx.languages,
        fileTree: ctx.fileTree,
        readme: ctx.readme || "",
        moduleDirs: ctx.moduleDirs || "",
        meta: meta as unknown as Record<string, unknown>,
      });
      setMetaReview(result);
      setAppliedIssues({});
      setEditingSuggestion({});
      // Seed editable copies so each suggestion can be adjusted before applying.
      setSuggestionDrafts(
        Object.fromEntries(result.issues.map((issue, idx) => [`${idx}:${issue.field}`, issue.suggestion]))
      );
    } catch (e) {
      setMetaReviewError(e instanceof Error ? e.message : "核对失败，请重试");
    } finally {
      setReviewingMeta(false);
    }
  };

  /**
   * Apply a (possibly user-edited) suggestion to the metadata.
   *
   * Array-valued fields (languages, tech categories) need splitting; scalar meta
   * fields are assigned directly. Name/version live on the project rather than meta.
   * `issueKey` is the per-row identity so two issues on the same field don't share
   * applied/edited state.
   */
  const handleApplySuggestion = (issueKey: string, field: string, suggestion: string) => {
    if (!meta) return;
    const value = suggestion.trim();
    if (!value) return;

    const markApplied = () => setAppliedIssues((prev) => ({ ...prev, [issueKey]: true }));

    if (field === "softwareName" || field === "version") {
      setProjectDraft((prev) => ({ ...prev, [field]: value }));
      updateProject(projectId, { [field]: value });
      setProject(getProject(projectId)!);
      markApplied();
      return;
    }

    const listFields: Record<string, string[]> = {
      languagesGiven: GIVEN_LANGUAGES,
      techCategoriesGiven: GIVEN_TECH_CATEGORIES,
    };
    if (field in listFields) {
      const allowed = listFields[field];
      const picked = value.split(/[,，、\s]+/).map((s) => s.trim()).filter((s) => allowed.includes(s));
      if (!picked.length) {
        setMetaReviewError(`「${META_FIELD_LABELS_UI[field] || field}」的建议值不在可选项中，未应用：${value}`);
        return;
      }
      setMeta({ ...meta, [field]: picked });
      markApplied();
      return;
    }

    if (field === "languagesExtra" || field === "techCategoriesExtra") {
      const parts = value.split(/[,，、]+/).map((s) => s.trim()).filter(Boolean);
      setMeta({ ...meta, [field]: parts });
      markApplied();
      return;
    }

    if (field === "sourceLines") {
      const n = parseInt(value.replace(/[^\d]/g, ""), 10);
      if (!isFinite(n)) {
        setMetaReviewError(`「源程序行数」的建议值无法解析为数字，未应用：${value}`);
        return;
      }
      setMeta({ ...meta, sourceLines: n });
      markApplied();
      return;
    }

    if (field === "category" && !SOFTWARE_CATEGORIES.includes(value)) {
      setMetaReviewError(`「软件分类」只能是 ${SOFTWARE_CATEGORIES.join(" / ")}，未应用：${value}`);
      return;
    }

    // Unknown key from the model → don't silently write a junk field.
    if (!(field in meta)) {
      setMetaReviewError(`建议指向未知字段「${field}」，未应用。请手动修改对应内容。`);
      return;
    }

    // Every remaining known key is a string field; an array-typed one would
    // break the UI's .join()/.includes() calls, so refuse rather than corrupt it.
    if (Array.isArray((meta as unknown as Record<string, unknown>)[field])) {
      setMetaReviewError(`「${META_FIELD_LABELS_UI[field] || field}」需要选择项而非文本，未应用。请在「编辑项目」中手动勾选。`);
      return;
    }

    setMeta({ ...meta, [field]: value });
    markApplied();
  };

  const handleAuditManual = async () => {
    if (!project || !meta) return;
    const md = manualMarkdown || project.manualMarkdown;
    if (!md?.trim()) {
      setAuditError("没有可审核的说明书内容");
      return;
    }
    setAuditingManual(true);
    setAuditError("");
    setManualAudit(null);
    try {
      let ctx = project.reviewContext;
      if (!ctx?.fileTree) {
        if (!accessToken) throw new Error("GitHub 授权已失效，请重新登录后再审核");
        if (!project.defaultBranch.trim()) throw new Error("项目未指定代码分支");
        const { allFilePaths } = await fetchRepoStats(
          accessToken, project.repoOwner, project.repoName, project.defaultBranch
        );
        const langStats = await fetchRepoLanguages(accessToken, project.repoOwner, project.repoName);
        const insights = await fetchRepoInsights(
          accessToken, project.repoOwner, project.repoName, project.defaultBranch, allFilePaths
        );
        ctx = {
          fileTree: insights.sourcePaths.slice(0, 60).join("\n"),
          languages: describeLanguageStats(langStats),
          codeSummary: insights.manifests
            .map((m) => `--- ${m.path} ---\n${m.content.slice(0, 1200)}`)
            .join("\n\n"),
          readme: insights.readme.slice(0, 4000),
          moduleDirs: insights.moduleDirs.join("\n").slice(0, 2000),
        };
        updateProject(projectId, { reviewContext: ctx });
        setProject(getProject(projectId)!);
      }

      const result = await auditManualMarkdown({
        softwareName: project.softwareName,
        version: project.version,
        meta: meta as unknown as Record<string, unknown>,
        languages: ctx.languages,
        fileTree: ctx.fileTree,
        codeSummary: ctx.codeSummary || ctx.readme || "",
        markdown: md,
      });
      setManualAudit(result);
    } catch (e) {
      setAuditError(e instanceof Error ? e.message : "审核失败，请重试");
    } finally {
      setAuditingManual(false);
    }
  };

  const handleReexportManualPDF = async () => {
    if (!project) return;
    const md = manualMarkdown || project.manualMarkdown || "";
    if (!md.trim()) {
      setError("没有可导出的说明书内容，请先生成或粘贴 Markdown");
      return;
    }
    setReexporting(true);
    setError("");
    try {
      setCurrentStep("正在根据修订稿重新排版 PDF...");
      const sanitizedMd = sanitizeSoftCopyrightText(md);
      const blob = await generateManualPDF(
        project.softwareName,
        project.version,
        "软件著作权人",
        sanitizedMd,
        (msg) => setCurrentStep(msg)
      );
      if (manualPdfUrl) URL.revokeObjectURL(manualPdfUrl);
      setManualPdfUrl(URL.createObjectURL(blob));
      setManualMarkdown(sanitizedMd);
      updateProject(projectId, { manualMarkdown: sanitizedMd, status: "DONE", errorMsg: undefined });
      setProject(getProject(projectId)!);
      setEditingManual(false);
      setCurrentStep("PDF 已根据修订内容重新生成");
    } catch (e) {
      setError(e instanceof Error ? e.message : "重新导出失败");
    } finally {
      setReexporting(false);
    }
  };

  if (!project || !meta) {
    return <div className="flex items-center justify-center min-h-screen"><div className="spinner w-8 h-8 border-2 border-[var(--color-primary)] border-t-transparent rounded-full" /></div>;
  }

  return (
    <div className="flex flex-col min-h-screen">
      <header className="border-b border-[var(--color-border)] px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          {/* Navigation is safe during generation — the run lives outside this
              component and keeps going, so no interception here. */}
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2">
              <Logo />
              <span className="text-lg font-semibold">软著通</span>
            </Link>
            <VersionBadge />
          </div>
          <Link
            href="/dashboard"
            className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors"
          >
            返回控制台
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-2">{project.softwareName}</h1>
          <p className="text-sm text-[var(--color-muted)]">{project.repoOwner}/{project.repoName} · {project.defaultBranch} · {project.version}</p>
        </div>

        {error && project.status !== "FAILED" && (
          <div className="bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded-xl p-4 mb-6 text-sm text-[var(--color-error)]">
            {error}
          </div>
        )}

        {project.status === "FAILED" && manualDraft?.markdown && !generating && (
          <div className="bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/30 rounded-xl p-5 mb-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <h2 className="text-base font-semibold mb-1">发现可恢复的说明书草稿</h2>
                <p className="text-sm text-[var(--color-muted)] whitespace-pre-wrap">
                  {project.errorMsg || error || "上次生成未正常完成。"}
                </p>
                <p className="text-xs text-[var(--color-muted)] mt-2">
                  {describeManualDraftResume(manualDraft)}
                </p>
                <p className="text-xs text-[var(--color-muted)] mt-1">
                  中断通常发生在刷新/关闭页面、路由切换、浏览器终止任务，或 AI 接口长时间无响应时。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => confirmStartGenerate({ resumeManual: true }, {
                    title: "从断点继续生成？",
                    message: "将从已保存的草稿继续生成说明书。生成过程中请不要刷新或关闭页面。",
                    confirmLabel: "继续生成",
                  })}
                  className="px-4 py-2 text-sm bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg transition-colors"
                >
                  从断点继续
                </button>
                <button
                  onClick={() => confirmStartGenerate({ freshManual: true }, {
                    title: "放弃草稿并重新开始？",
                    message: `已保存的 ${manualDraft?.lines || 0} 行草稿将被删除，无法恢复，整份说明书需要重新生成。`,
                    confirmLabel: "放弃草稿，重新开始",
                    destructive: true,
                  })}
                  className="px-4 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors"
                >
                  放弃草稿，重新开始
                </button>
              </div>
            </div>
          </div>
        )}

        {!generating && project.status !== "PROCESSING" && (
          <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 mb-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">项目设置</h2>
                <p className="text-xs text-[var(--color-muted)] mt-1">
                  当前材料来源：{project.repoOwner}/{project.repoName} · {project.defaultBranch}
                </p>
              </div>
              {!editingProject ? (
                <button
                  onClick={startEditProject}
                  className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:border-[var(--color-primary)] transition-colors"
                >
                  编辑项目
                </button>
              ) : null}
            </div>

            {editingProject ? (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-[var(--color-muted)] mb-1">软件全称 *</label>
                    <input
                      type="text"
                      value={projectDraft.softwareName}
                      onChange={(e) => setProjectDraft((prev) => ({ ...prev, softwareName: e.target.value }))}
                      className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--color-muted)] mb-1">版本号 *</label>
                    <input
                      type="text"
                      value={projectDraft.version}
                      onChange={(e) => setProjectDraft((prev) => ({ ...prev, version: e.target.value }))}
                      className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-[var(--color-muted)] mb-1">开发完成日期</label>
                    <input
                      type="date"
                      value={projectDraft.completedAt}
                      onChange={(e) => setProjectDraft((prev) => ({ ...prev, completedAt: e.target.value }))}
                      className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--color-muted)] mb-1">代码分支 *</label>
                    {branches.length > 0 ? (
                      <select
                        value={projectDraft.branch}
                        onChange={(e) => setProjectDraft((prev) => ({ ...prev, branch: e.target.value }))}
                        disabled={loadingBranches}
                        className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] disabled:opacity-50"
                      >
                        {projectDraft.branch && !branches.some((branch) => branch.name === projectDraft.branch) ? (
                          <option value={projectDraft.branch}>{projectDraft.branch}（当前保存分支）</option>
                        ) : null}
                        {branches.map((branch) => (
                          <option key={branch.name} value={branch.name}>{branch.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={projectDraft.branch}
                        onChange={(e) => setProjectDraft((prev) => ({ ...prev, branch: e.target.value }))}
                        placeholder={loadingBranches ? "正在读取分支列表..." : "请输入分支名"}
                        disabled={loadingBranches}
                        className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] disabled:opacity-50"
                      />
                    )}
                  </div>
                </div>

                {projectDraft.branch.trim() && projectDraft.branch.trim() !== project.defaultBranch ? (
                  <p className="text-xs text-[var(--color-muted)]">
                    切换分支后，已生成的程序/文档材料将不再沿用，保存后需要重新检测并生成。
                  </p>
                ) : null}

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs text-[var(--color-muted)]">仓库描述（用于 AI 分析项目用途）</label>
                    <button
                      type="button"
                      onClick={handleRefreshRepoDescription}
                      disabled={refreshingRepoDesc || !accessToken}
                      className="text-xs text-[var(--color-primary)] hover:underline disabled:opacity-50"
                    >
                      {refreshingRepoDesc ? "获取中..." : "从 GitHub 获取"}
                    </button>
                  </div>
                  <textarea
                    value={projectDraft.repoDescription}
                    onChange={(e) => setProjectDraft((prev) => ({ ...prev, repoDescription: e.target.value }))}
                    rows={2}
                    placeholder="GitHub 仓库描述，留空则 AI 只依据 README 和目录结构判断"
                    className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] resize-none"
                  />
                </div>

                {/* Full registration metadata — everything filled at creation time
                    is editable here so mistakes can be corrected without recreating. */}
                {metaDraft && (
                  <div className="border-t border-[var(--color-border)] pt-4 space-y-4">
                    <h3 className="text-sm font-medium">登记信息（创建时填写，可修改）</h3>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs text-[var(--color-muted)] mb-1">软件分类</label>
                        <select
                          value={metaDraft.category}
                          onChange={(e) => setMetaDraft({ ...metaDraft, category: e.target.value })}
                          className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                        >
                          {SOFTWARE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-[var(--color-muted)] mb-1">源程序行数</label>
                        <input
                          type="number"
                          value={metaDraft.sourceLines || 0}
                          onChange={(e) => setMetaDraft({ ...metaDraft, sourceLines: parseInt(e.target.value, 10) || 0 })}
                          className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-[var(--color-muted)] mb-2">编程语言（给定项）</label>
                      <div className="flex flex-wrap gap-2">
                        {GIVEN_LANGUAGES.map((lang) => {
                          const on = metaDraft.languagesGiven.includes(lang);
                          return (
                            <button
                              key={lang}
                              type="button"
                              onClick={() => setMetaDraft({
                                ...metaDraft,
                                languagesGiven: on
                                  ? metaDraft.languagesGiven.filter((l) => l !== lang)
                                  : [...metaDraft.languagesGiven, lang],
                              })}
                              className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${on ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-muted)]"}`}
                            >
                              {lang}
                            </button>
                          );
                        })}
                      </div>
                      <input
                        type="text"
                        placeholder="补充语言（逗号分隔）"
                        value={metaDraft.languagesExtra.join(", ")}
                        onChange={(e) => setMetaDraft({ ...metaDraft, languagesExtra: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        className="w-full mt-2 px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-[var(--color-muted)] mb-2">技术特点分类</label>
                      <div className="flex flex-wrap gap-2">
                        {GIVEN_TECH_CATEGORIES.map((cat) => {
                          const on = metaDraft.techCategoriesGiven.includes(cat);
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => setMetaDraft({
                                ...metaDraft,
                                techCategoriesGiven: on
                                  ? metaDraft.techCategoriesGiven.filter((c) => c !== cat)
                                  : [...metaDraft.techCategoriesGiven, cat],
                              })}
                              className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${on ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-muted)]"}`}
                            >
                              {cat}
                            </button>
                          );
                        })}
                      </div>
                      <input
                        type="text"
                        placeholder="补充分类（逗号分隔）"
                        value={metaDraft.techCategoriesExtra.join(", ")}
                        onChange={(e) => setMetaDraft({ ...metaDraft, techCategoriesExtra: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        className="w-full mt-2 px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <DraftInput label="开发硬件环境" value={metaDraft.devHardware} onChange={(v) => setMetaDraft({ ...metaDraft, devHardware: v })} />
                      <DraftInput label="运行硬件环境" value={metaDraft.runHardware} onChange={(v) => setMetaDraft({ ...metaDraft, runHardware: v })} />
                      <DraftInput label="开发操作系统" value={metaDraft.devOS} onChange={(v) => setMetaDraft({ ...metaDraft, devOS: v })} />
                      <DraftInput label="开发工具" value={metaDraft.devTools} onChange={(v) => setMetaDraft({ ...metaDraft, devTools: v })} />
                      <DraftInput label="运行平台" value={metaDraft.runPlatform} onChange={(v) => setMetaDraft({ ...metaDraft, runPlatform: v })} />
                      <DraftInput label="运行支撑环境" value={metaDraft.runSupport} onChange={(v) => setMetaDraft({ ...metaDraft, runSupport: v })} />
                      <DraftInput label="面向领域/行业" value={metaDraft.domain} onChange={(v) => setMetaDraft({ ...metaDraft, domain: v })} />
                      <div>
                        <label className="block text-xs text-[var(--color-muted)] mb-1">发表状态</label>
                        <select
                          value={metaDraft.publishStatus}
                          onChange={(e) => setMetaDraft({ ...metaDraft, publishStatus: e.target.value })}
                          className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                        >
                          <option value="未发表">未发表</option>
                          <option value="已发表">已发表</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-[var(--color-muted)] mb-1">原创/修改</label>
                        <select
                          value={metaDraft.originalType}
                          onChange={(e) => setMetaDraft({ ...metaDraft, originalType: e.target.value })}
                          className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                        >
                          <option value="原创">原创</option>
                          <option value="修改">修改</option>
                          <option value="翻译">翻译</option>
                          <option value="合成">合成</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-[var(--color-muted)] mb-1">开发方式</label>
                        <select
                          value={metaDraft.devMethod}
                          onChange={(e) => setMetaDraft({ ...metaDraft, devMethod: e.target.value })}
                          className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
                        >
                          <option value="单独开发">单独开发</option>
                          <option value="合作开发">合作开发</option>
                          <option value="委托开发">委托开发</option>
                          <option value="下达任务开发">下达任务开发</option>
                        </select>
                      </div>
                    </div>

                    <DraftTextarea label="开发目的" value={metaDraft.purpose} onChange={(v) => setMetaDraft({ ...metaDraft, purpose: v })} />
                    <DraftTextarea label="主要功能" value={metaDraft.mainFeatures} onChange={(v) => setMetaDraft({ ...metaDraft, mainFeatures: v })} rows={3} />
                    <DraftTextarea label="技术特点" value={metaDraft.technicalFeatures} onChange={(v) => setMetaDraft({ ...metaDraft, technicalFeatures: v })} />
                    <DraftTextarea label="软件说明" value={metaDraft.softwareDescription} onChange={(v) => setMetaDraft({ ...metaDraft, softwareDescription: v })} />
                  </div>
                )}

                {projectDraft.branch.trim() === project.defaultBranch && (project.manualMarkdown || manualMarkdown) && (
                  <label className="flex items-start gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={forceRegenerate}
                      onChange={(e) => setForceRegenerate(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-[var(--color-muted)]">
                      清空已生成的材料，保存后重新生成（仅改名字/版本时，默认同步文稿而不清空；勾选此项则强制清空）
                    </span>
                  </label>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleSaveProjectEdit}
                    disabled={savingProject || !projectDraft.softwareName.trim() || !projectDraft.version.trim() || !projectDraft.branch.trim()}
                    className="px-4 py-2 text-sm bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg transition-colors disabled:opacity-50"
                  >
                    {savingProject ? "保存中..." : "保存项目"}
                  </button>
                  <button
                    onClick={() => { setEditingProject(false); setMetaDraft(null); setError(""); }}
                    className="px-4 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Metadata display/edit */}
        {project.status === "PENDING" && !generating && (
          <div className="space-y-6">
            <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
              <div className="flex items-start justify-between gap-4 mb-4">
                <h2 className="text-base font-semibold">软件信息（自动生成，可编辑）</h2>
                <button
                  onClick={handleReviewMeta}
                  disabled={reviewingMeta || generating}
                  className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:border-[var(--color-primary)] transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  title="AI 核对当前填写是否合理"
                >
                  {reviewingMeta ? (
                    <>
                      <div className="spinner w-3 h-3 border border-[var(--color-primary)] border-t-transparent rounded-full" />
                      AI 核对中...
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      AI 核对
                    </>
                  )}
                </button>
              </div>
              {!metaReady && <p className="text-xs text-[var(--color-primary)] mb-4">{detectStatus || "正在自动检测和生成元数据..."}</p>}
              {metaReady && detectStatus && (
                <p className="text-xs text-[var(--color-error)] mb-4">{detectStatus}</p>
              )}

              {metaReviewError && (
                <div className="mb-4 bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded-lg p-3 text-xs text-[var(--color-error)]">
                  {metaReviewError}
                </div>
              )}

              {metaReview && (
                <div className="mb-4 bg-[#F2E3D6] border border-[#C4612F]/20 rounded-lg p-4">
                  <div className="flex items-start gap-2 mb-3">
                    <svg className="w-4 h-4 text-[#C4612F] flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-[#1F2421] mb-1">AI 核对结果</div>
                      <p className="text-xs text-[#5C635D]">{metaReview.overallComment}</p>
                    </div>
                  </div>

                  {/* Capability coverage: shows what the repo does vs. what 主要功能 lists,
                      so omissions are visible even when the model files no issue. */}
                  {metaReview.detectedCapabilities.length > 0 && (
                    <details className="mb-3 ml-6 text-xs">
                      <summary className="cursor-pointer text-[#5C635D] hover:text-[#1F2421]">
                        AI 识别到的项目能力（{metaReview.detectedCapabilities.length} 项）
                        {metaReview.missingFromMainFeatures.length > 0 && (
                          <span className="ml-1 text-[var(--color-error)]">
                            · 其中 {metaReview.missingFromMainFeatures.length} 项未写入主要功能
                          </span>
                        )}
                      </summary>
                      <ul className="mt-2 space-y-1 pl-4">
                        {metaReview.detectedCapabilities.map((cap, i) => {
                          const missing = metaReview.missingFromMainFeatures.includes(cap);
                          return (
                            <li key={i} className={`list-disc ${missing ? "text-[var(--color-error)]" : "text-[#5C635D]"}`}>
                              {cap}{missing ? "（未覆盖）" : ""}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}

                  {metaReview.issues.length === 0 ? (
                    <p className="text-xs text-[#5C635D] pl-6">未发现明显问题。</p>
                  ) : (
                    <div className="space-y-2 pl-6">
                      {metaReview.issues.map((issue, idx) => {
                        const issueKey = `${idx}:${issue.field}`;
                        const applied = appliedIssues[issueKey];
                        const draft = suggestionDrafts[issueKey] ?? issue.suggestion;
                        const isEditing = !!editingSuggestion[issueKey];
                        const edited = draft.trim() !== issue.suggestion.trim();
                        return (
                          <div
                            key={issueKey}
                            className={`border rounded-lg p-3 text-xs ${
                              applied
                                ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/5 opacity-60"
                                : issue.severity === "high"
                                ? "border-[var(--color-error)]/30 bg-[var(--color-error)]/5"
                                : "border-[var(--color-border)] bg-[var(--color-card)]"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <span className="font-medium text-[#1F2421]">
                                {issue.fieldLabel}
                                <span className="ml-1.5 font-normal text-[10px] text-[#5C635D]">{issue.kind}</span>
                              </span>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] ${
                                  issue.severity === "high"
                                    ? "bg-[var(--color-error)]/20 text-[var(--color-error)]"
                                    : issue.severity === "low"
                                    ? "bg-[var(--color-muted)]/20 text-[var(--color-muted)]"
                                    : "bg-[#C4612F]/20 text-[#C4612F]"
                                }`}
                              >
                                {issue.severity === "high" ? "严重" : issue.severity === "low" ? "轻微" : "中等"}
                              </span>
                            </div>
                            <p className="text-[#5C635D] mb-2">问题：{issue.problem}</p>

                            <div className="text-[#5C635D] mb-1">
                              建议{edited ? "（已手动修改）" : ""}：
                            </div>
                            {isEditing ? (
                              <textarea
                                value={draft}
                                onChange={(e) => setSuggestionDrafts((prev) => ({ ...prev, [issueKey]: e.target.value }))}
                                rows={4}
                                className="w-full px-2 py-1.5 mb-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded text-xs leading-relaxed focus:outline-none focus:border-[var(--color-primary)]"
                              />
                            ) : (
                              <p className="text-[#5C635D] mb-2 whitespace-pre-wrap">{draft}</p>
                            )}

                            <div className="flex flex-wrap items-center gap-2">
                              {!applied && (
                                <>
                                  <button
                                    onClick={() => handleApplySuggestion(issueKey, issue.field, draft)}
                                    disabled={!draft.trim()}
                                    className="px-2 py-1 text-[10px] border border-[var(--color-border)] rounded hover:border-[var(--color-primary)] transition-colors disabled:opacity-50"
                                  >
                                    应用
                                  </button>
                                  <button
                                    onClick={() => setEditingSuggestion((prev) => ({ ...prev, [issueKey]: !isEditing }))}
                                    className="px-2 py-1 text-[10px] border border-[var(--color-border)] rounded text-[#5C635D] hover:border-[var(--color-muted)] transition-colors"
                                  >
                                    {isEditing ? "收起编辑" : "编辑建议"}
                                  </button>
                                  {edited && (
                                    <button
                                      onClick={() => setSuggestionDrafts((prev) => ({ ...prev, [issueKey]: issue.suggestion }))}
                                      className="px-2 py-1 text-[10px] text-[#5C635D] hover:text-[#1F2421] transition-colors"
                                    >
                                      恢复原建议
                                    </button>
                                  )}
                                </>
                              )}
                              {applied && (
                                <span className="text-[10px] text-[var(--color-success)]">✓ 已应用</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 text-sm">
                <MetaField label="软件分类" value={meta.category} />
                <MetaField label="编程语言" value={meta.languagesGiven.join(", ") || "检测中..."} />
                <MetaField label="源程序行数" value={meta.sourceLines ? `${meta.sourceLines} 行` : "统计中..."} />
                <MetaField label="开发工具" value={meta.devTools || "检测中..."} />
                <MetaField label="开发硬件环境" value={meta.devHardware || "检测中..."} />
                <MetaField label="运行硬件环境" value={meta.runHardware || "检测中..."} />
                <MetaField label="开发操作系统" value={meta.devOS || "检测中..."} />
                <MetaField label="运行平台" value={meta.runPlatform || "AI 生成中..."} />
                <MetaField label="运行支撑环境" value={meta.runSupport || "AI 生成中..."} />
                <MetaField label="面向领域" value={meta.domain || "AI 生成中..."} />
              </div>
              <div className="mt-4 space-y-3">
                <EditableField label="开发目的" value={meta.purpose} onChange={(v) => setMeta({ ...meta, purpose: v })} placeholder="AI 生成中..." />
                <EditableField label="主要功能" value={meta.mainFeatures} onChange={(v) => setMeta({ ...meta, mainFeatures: v })} placeholder="AI 生成中..." rows={4} />
                <EditableField label="技术特点" value={meta.technicalFeatures} onChange={(v) => setMeta({ ...meta, technicalFeatures: v })} placeholder="AI 生成中..." />
                <EditableField label="软件说明" value={meta.softwareDescription} onChange={(v) => setMeta({ ...meta, softwareDescription: v })} placeholder="用于登记表「软件说明」栏" />
              </div>
            </div>

            <button
              onClick={() => confirmStartGenerate(undefined, {
                title: "开始生成材料？",
                message: "生成过程会调用 AI 逐章撰写说明书，可能需要数分钟。期间请勿刷新或关闭页面。",
                confirmLabel: "开始生成",
              })}
              disabled={!metaReady || generating}
              className="w-full py-3 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {metaReady ? "确认信息并开始生成" : "正在检测元数据..."}
            </button>
            <p className="text-xs text-[var(--color-muted)] text-center">
              说明：程序鉴别材料来自源码（常见要求约 3000–6000 行源程序）；文档鉴别材料是操作说明书，目标约 2000 行文档内容以排成约 60 页，不是代码行数。
            </p>
          </div>
        )}

        {/* Progress */}
        {(project.status === "PROCESSING" || generating) && (
          <div className="py-8">
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-[var(--color-muted)]">
                  {generating ? currentStep || "生成中..." : "准备中..."}
                </span>
                <span className="text-sm font-medium">{progress}%</span>
              </div>
              <div className="w-full h-2 bg-[var(--color-border)] rounded-full overflow-hidden">
                <div className="h-full bg-[var(--color-primary)] transition-all duration-500 ease-out rounded-full" style={{ width: `${progress}%` }} />
              </div>
              {manualDraft?.lines ? (
                <p className="text-xs text-[var(--color-muted)] mt-2">
                  说明书草稿已缓存：{manualDraft.lines} 行文档（中断后可从断点继续，不必整份重写）
                </p>
              ) : null}
              {generating && (
                <p className="text-xs text-[var(--color-primary)] mt-2">
                  正在生成中，请勿刷新或关闭页面（关闭页面会中断任务）。可以切换到其他页面，任务会在后台继续，返回本页可继续查看进度。
                </p>
              )}
            </div>
            <div className="space-y-3">
              {steps.map((step, i) => {
                const isDone = i < stepIndex || (i === stepIndex && progress >= 100);
                const isCurrent = i === stepIndex && progress < 100;
                return (
                  <div key={i} className={`flex items-center gap-3 py-2 px-3 rounded-lg ${isCurrent ? "bg-[var(--color-primary)]/10" : ""}`}>
                    {isDone ? (
                      <svg className="w-5 h-5 text-[var(--color-success)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    ) : isCurrent ? (
                      <div className="spinner w-5 h-5 border-2 border-[var(--color-primary)] border-t-transparent rounded-full flex-shrink-0" />
                    ) : (
                      <div className="w-5 h-5 border-2 border-[var(--color-border)] rounded-full flex-shrink-0" />
                    )}
                    <span className={`text-sm ${i > stepIndex ? "text-[var(--color-muted)]" : isCurrent ? "text-[var(--color-foreground)] font-medium" : "text-[var(--color-muted-foreground)]"}`}>{step}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Done */}
        {project.status === "DONE" && meta && (
          <div className="py-6 space-y-6">
            <div className="bg-[var(--color-success)]/10 border border-[var(--color-success)]/20 rounded-xl p-5">
              <div className="flex items-center gap-3">
                <svg className="w-6 h-6 text-[var(--color-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                <span className="text-lg font-semibold text-[var(--color-success)]">材料生成完成！请复制以下信息到版权局登记系统</span>
              </div>
            </div>

            {/* Download */}
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => handleDownload(codePdfUrl, `${project.softwareName}_程序鉴别材料.pdf`)}
                disabled={!codePdfUrl}
                className="py-3 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg font-medium transition-colors text-center disabled:opacity-50"
              >
                {codePdfUrl ? "下载程序鉴别材料" : "程序 PDF 需重新生成"}
              </button>
              <button
                onClick={() => handleDownload(manualPdfUrl, `${project.softwareName}_文档鉴别材料.pdf`)}
                disabled={!manualPdfUrl}
                className="py-3 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg font-medium transition-colors text-center disabled:opacity-50"
              >
                {manualPdfUrl ? "下载文档鉴别材料" : "请先重新导出文档 PDF"}
              </button>
            </div>
            {!codePdfUrl && !manualPdfUrl && (manualMarkdown || project.manualMarkdown) && (
              <p className="text-xs text-[var(--color-muted)]">
                刷新页面后内存中的 PDF 会失效。说明书文稿仍保留：可点「重新导出 PDF」恢复文档鉴别材料；程序鉴别材料请点下方「重新生成」。
              </p>
            )}

            {/* Editable manual source */}
            <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-base font-semibold">说明书文稿（可编辑）</h2>
                  <p className="text-xs text-[var(--color-muted)] mt-1">
                    PDF 本身不宜直接改字。请在此修订 Markdown，再点「重新导出 PDF」。也可下载 .md 用本地编辑器修改后粘贴回来。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleDownloadMarkdown}
                    className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors"
                  >
                    下载 Markdown
                  </button>
                  {!editingManual ? (
                    <button
                      onClick={() => {
                        setManualMarkdown(manualMarkdown || project.manualMarkdown || "");
                        setEditingManual(true);
                      }}
                      className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:border-[var(--color-primary)] transition-colors"
                    >
                      编辑文稿
                    </button>
                  ) : (
                    <button
                      onClick={handleSaveManualEdit}
                      className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:border-[var(--color-primary)] transition-colors"
                    >
                      保存文稿
                    </button>
                  )}
                  <button
                    onClick={handleReexportManualPDF}
                    disabled={reexporting || generating || !(manualMarkdown || project.manualMarkdown)}
                    className="px-3 py-1.5 text-xs bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg transition-colors disabled:opacity-50"
                  >
                    {reexporting ? "导出中..." : "重新导出 PDF"}
                  </button>
                </div>
              </div>
              {editingManual ? (
                <textarea
                  value={manualMarkdown}
                  onChange={(e) => setManualMarkdown(e.target.value)}
                  rows={18}
                  className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-xs font-mono leading-relaxed focus:outline-none focus:border-[var(--color-primary)]"
                  placeholder="说明书 Markdown..."
                />
              ) : (
                <pre className="max-h-64 overflow-auto text-xs text-[var(--color-muted)] whitespace-pre-wrap bg-black/20 rounded-lg p-3 border border-[var(--color-border)]">
                  {(manualMarkdown || project.manualMarkdown || "（暂无文稿，请重新生成）").slice(0, 4000)}
                  {(manualMarkdown || project.manualMarkdown || "").length > 4000 ? "\n…（已截断预览，点编辑可查看全文）" : ""}
                </pre>
              )}
              {currentStep && reexporting && (
                <p className="text-xs text-[var(--color-primary)]">{currentStep}</p>
              )}
            </div>

            {/* AI 审核说明书 */}
            <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 space-y-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="text-base font-semibold">AI 审核说明书</h2>
                  <p className="text-xs text-[var(--color-muted)] mt-1">
                    检查文档是否与项目一致、是否存在幻觉/编造、是否符合软著规范，并给出初步通过概率评估。
                  </p>
                </div>
                <button
                  onClick={handleAuditManual}
                  disabled={auditingManual || generating}
                  className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:border-[var(--color-primary)] transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  title="AI 审核当前说明书质量"
                >
                  {auditingManual ? (
                    <>
                      <div className="spinner w-3 h-3 border border-[var(--color-primary)] border-t-transparent rounded-full" />
                      审核中...
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                      </svg>
                      审核说明书
                    </>
                  )}
                </button>
              </div>

              {auditError && (
                <div className="bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded-lg p-3 text-xs text-[var(--color-error)]">
                  {auditError}
                </div>
              )}

              {manualAudit && (
                <div className="bg-[#F2E3D6] border border-[#C4612F]/20 rounded-lg p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white/60 rounded-lg p-3">
                      <div className="text-xs text-[#5C635D] mb-1">文档质量评分</div>
                      <div className="text-2xl font-semibold text-[#1F2421]">{manualAudit.score}<span className="text-sm text-[#5C635D]">/100</span></div>
                    </div>
                    <div className="bg-white/60 rounded-lg p-3">
                      <div className="text-xs text-[#5C635D] mb-1">初步通过概率</div>
                      <div className="text-2xl font-semibold text-[#1F2421]">{manualAudit.passProbability}<span className="text-sm text-[#5C635D]">%</span></div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-[#1F2421] mb-1">总体评价</div>
                    <p className="text-xs text-[#5C635D]">{manualAudit.summary}</p>
                  </div>

                  {manualAudit.strengths.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-[#1F2421] mb-2 flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5 text-[var(--color-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        合格项/亮点
                      </div>
                      <ul className="space-y-1 text-xs text-[#5C635D] pl-5">
                        {manualAudit.strengths.map((s, idx) => (
                          <li key={idx} className="list-disc">{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {manualAudit.findings.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-[#1F2421] mb-2 flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5 text-[var(--color-error)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        发现的问题 ({manualAudit.findings.length})
                      </div>
                      <div className="space-y-2">
                        {manualAudit.findings.map((finding, idx) => (
                          <div
                            key={idx}
                            className={`border rounded-lg p-3 text-xs ${
                              finding.severity === "high"
                                ? "border-[var(--color-error)]/30 bg-[var(--color-error)]/5"
                                : finding.severity === "low"
                                ? "border-[var(--color-border)] bg-white/40"
                                : "border-[#C4612F]/30 bg-white/60"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <span className="font-medium text-[#1F2421]">{finding.category}</span>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] ${
                                  finding.severity === "high"
                                    ? "bg-[var(--color-error)]/20 text-[var(--color-error)]"
                                    : finding.severity === "low"
                                    ? "bg-[var(--color-muted)]/20 text-[var(--color-muted)]"
                                    : "bg-[#C4612F]/20 text-[#C4612F]"
                                }`}
                              >
                                {finding.severity === "high" ? "严重" : finding.severity === "low" ? "轻微" : "中等"}
                              </span>
                            </div>
                            {finding.location && (
                              <p className="text-[#5C635D] mb-1">位置：{finding.location}</p>
                            )}
                            <p className="text-[#5C635D] mb-1">问题：{finding.problem}</p>
                            <p className="text-[#5C635D]">建议：{finding.suggestion}</p>
                          </div>
                        ))}
                      </div>
                      <p className="text-[10px] text-[#5C635D] mt-2">
                        提示：请在上方「编辑文稿」区域修改 Markdown，再点「重新导出 PDF」。
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={() => requestConfirm({
                title: "清空并重新生成？",
                message: "已生成的说明书文稿和 PDF 将被清除，无法恢复。项目会回到待生成状态，需要重新走一遍完整生成流程。",
                confirmLabel: "清空并重新生成",
                destructive: true,
                run: () => {
                  forgetRun(projectId);
                  clearManualDraft(projectId);
                  setManualDraft(null);
                  updateProject(projectId, { status: "PENDING" });
                  setProject(getProject(projectId)!);
                  setMetaReady(false);
                  setCodePdfUrl(null);
                  setManualPdfUrl(null);
                  setManualMarkdown("");
                  setManualAudit(null);
                  setMetaReview(null);
                },
              })}
              className="px-6 py-3 border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors">重新生成</button>

            {/* Registration form reference */}
            <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-6">
              <h2 className="text-base font-semibold mb-4">软件著作权登记 — 填表参考</h2>
              <p className="text-xs text-[var(--color-muted)] mb-4">以下信息可直接复制粘贴到中国版权保护中心登记系统</p>

              <div className="space-y-4">
                <CopyField label="软件全称" value={project.softwareName} />
                <CopyField label="版本号" value={project.version} />
                <CopyField label="软件分类" value={meta.category} />
                <CopyField label="软件说明" value={meta.softwareDescription || meta.purpose || "-"} />
                <CopyField label="原创修改" value={meta.originalType} hint="含翻译软件、合成软件" />
                <CopyField label="开发方式" value={meta.devMethod} hint="单独开发/合作开发/委托开发/下达任务开发" />
                <CopyField label="开发完成日期" value={project.completedAt || "-"} />
                <CopyField label="发表状态" value={meta.publishStatus} />
                <CopyField label="开发的硬件环境" value={meta.devHardware} />
                <CopyField label="运行的硬件环境" value={meta.runHardware} />
                <CopyField label="开发该软件的操作系统" value={meta.devOS} />
                <CopyField label="软件开发环境 / 开发工具" value={meta.devTools} />
                <CopyField label="该软件的运行平台 / 操作系统" value={meta.runPlatform} />
                <CopyField label="软件运行支撑环境 / 支持软件" value={meta.runSupport} />
                <CopyField label="编程语言（给定项）" value={meta.languagesGiven.join("、") || "无"} />
                <CopyField label="编程语言（补充项）" value={meta.languagesExtra.join("、") || "无"} />
                <CopyField label="源程序量" value={`${meta.sourceLines} 行`} />
                <CopyField label="开发目的" value={meta.purpose} />
                <CopyField label="面向领域 / 行业" value={meta.domain} />
                <CopyField label="软件的主要功能" value={meta.mainFeatures} />
                <CopyField label="技术特点分类（给定项）" value={meta.techCategoriesGiven.join("、") || "无"} />
                <CopyField label="技术特点（补充说明）" value={meta.techCategoriesExtra.join("、") || meta.technicalFeatures} />
              </div>
            </div>

            {/* Upload guidance */}
            <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-6">
              <h2 className="text-base font-semibold mb-4">鉴别材料上传指引</h2>
              <div className="space-y-4 text-sm">
                <UploadGuide
                  title="程序鉴别材料"
                  desc="一般交存：源程序前连续的30页和后连续的30页"
                  file="程序鉴别材料.pdf"
                  format="PDF"
                  onDownload={() => handleDownload(codePdfUrl, `${project.softwareName}_程序鉴别材料.pdf`)}
                />
                <UploadGuide
                  title="文档鉴别材料"
                  desc="一般交存：提交任何一种文档的前连续的30页和后连续的30页"
                  file="文档鉴别材料.pdf"
                  format="PDF"
                  onDownload={() => handleDownload(manualPdfUrl, `${project.softwareName}_文档鉴别材料.pdf`)}
                />
                <div className="border border-[var(--color-border)] rounded-lg p-4 opacity-60">
                  <div className="font-medium mb-1">其他相关证明文件</div>
                  <p className="text-xs text-[var(--color-muted)]">如无特殊要求，此项无需上传，直接跳过即可。</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Failed */}
        {project.status === "FAILED" && !generating && (
          <div className="py-8">
            <div className="bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded-xl p-6 mb-6">
              <div className="flex items-center gap-3 mb-2">
                <svg className="w-6 h-6 text-[var(--color-error)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                <span className="text-lg font-semibold text-[var(--color-error)]">生成失败</span>
              </div>
              <p className="text-sm text-[var(--color-muted)] whitespace-pre-wrap">{project.errorMsg || error || "未知错误，请重试。"}</p>
              {manualDraft?.markdown && (
                <div className="mt-4 rounded-lg border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 px-3 py-2 text-sm">
                  {describeManualDraftResume(manualDraft)}
                  <p className="text-xs text-[var(--color-muted)] mt-1">
                    可从断点继续，不必整份重写。程序鉴别材料仍会重新排版生成。
                  </p>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              {manualDraft?.markdown ? (
                <button
                  onClick={() => confirmStartGenerate({ resumeManual: true }, {
                    title: "从断点继续生成？",
                    message: "将从已保存的草稿继续生成说明书。生成过程中请不要刷新或关闭页面。",
                    confirmLabel: "继续生成",
                  })}
                  className="px-6 py-3 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg font-medium transition-colors"
                >
                  从断点继续生成说明书
                </button>
              ) : null}
              <button
                onClick={() => confirmStartGenerate(
                  manualDraft?.markdown ? { freshManual: true } : undefined,
                  manualDraft?.markdown
                    ? {
                        title: "放弃草稿并重新开始？",
                        message: `已保存的 ${manualDraft.lines || 0} 行草稿将被删除，无法恢复，整份说明书需要重新生成。`,
                        confirmLabel: "放弃草稿，重新开始",
                        destructive: true,
                      }
                    : {
                        title: "重新生成材料？",
                        message: "生成过程会调用 AI 逐章撰写说明书，可能需要数分钟。期间请勿刷新或关闭页面。",
                        confirmLabel: "开始生成",
                      }
                )}
                className="px-6 py-3 border border-[var(--color-border)] hover:border-[var(--color-primary)] rounded-lg font-medium transition-colors"
              >
                {manualDraft?.markdown ? "放弃草稿，重新开始" : "重新生成"}
              </button>
            </div>
            <p className="text-xs text-[var(--color-muted)] mt-4">
              小提示：进度里的「目标 2000 行」指操作说明书文档行数（用于文档鉴别材料约 60 页），不是源程序 6000 行。源程序行数在「程序鉴别材料」里按仓库代码处理。
            </p>
          </div>
        )}
      </main>

      {pendingConfirm && (
        <ConfirmDialog
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          destructive={pendingConfirm.destructive}
          onConfirm={() => {
            const run = pendingConfirm.run;
            setPendingConfirm(null);
            run();
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-muted)] mb-1">{label}</div>
      <div className="text-sm">{value || <span className="text-[var(--color-muted)]">-</span>}</div>
    </div>
  );
}

function DraftInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs text-[var(--color-muted)] mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)]"
      />
    </div>
  );
}

function DraftTextarea({ label, value, onChange, rows = 2 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <div>
      <label className="block text-xs text-[var(--color-muted)] mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] resize-none"
      />
    </div>
  );
}

function EditableField({ label, value, onChange, placeholder, rows = 2 }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <div>
      <label className="block text-xs text-[var(--color-muted)] mb-1">{label}</label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
        className="w-full px-3 py-2 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] resize-none" />
    </div>
  );
}

function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-start gap-3 py-2 border-b border-[var(--color-border)] last:border-0">
      <div className="w-48 flex-shrink-0 text-sm text-[var(--color-muted)] pt-0.5">{label}</div>
      <div className="flex-1 text-sm min-w-0">
        <div className="break-words">{value || <span className="text-[var(--color-muted)]">-</span>}</div>
        {hint && <div className="text-xs text-[var(--color-muted)] mt-0.5">{hint}</div>}
      </div>
      <button onClick={handleCopy}
        className="flex-shrink-0 px-2 py-1 text-xs border border-[var(--color-border)] rounded text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-muted)] transition-colors">
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

function UploadGuide({ title, desc, file, format, onDownload }: { title: string; desc: string; file: string; format: string; onDownload?: () => void }) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4">
      <div className="font-medium mb-1">{title}</div>
      <p className="text-xs text-[var(--color-muted)] mb-2">{desc}，请上传{format}格式。</p>
      <div className="flex items-center gap-3 text-sm">
        <svg className="w-4 h-4 text-[var(--color-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        <span className="text-[var(--color-success)]">{file}</span>
        {onDownload && (
          <button onClick={onDownload} className="text-xs text-[var(--color-primary)] hover:underline">下载</button>
        )}
      </div>
    </div>
  );
}

export default function ProjectDetailPage() {
  return (
    <ErrorBoundary title="项目详情页出错">
      <SessionProvider><ProjectDetailContent /></SessionProvider>
    </ErrorBoundary>
  );
}
