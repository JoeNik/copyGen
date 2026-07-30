"use client";
import Logo from "@/components/Logo";


import { useSession } from "next-auth/react";
import { SessionProvider } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { getProject, updateProject, getAIKey, getManualDraft, saveManualDraft, clearManualDraft, type Project, type SoftwareMeta, type ManualDraft } from "@/lib/storage";
import { fetchRepoBranches, fetchRepoFiles, fetchRepoStats, type GitHubBranch } from "@/lib/github";
import { generateManualMarkdown, callAIForText, buildMetadataPrompt, sanitizeSoftCopyrightText, reviewProjectMeta, auditManualMarkdown, type MetaReviewResult, type ManualAuditResult } from "@/lib/ai-helpers";
import { generateCodePDF } from "@/lib/docgen/code-pdf";
import { generateManualPDF } from "@/lib/docgen/manual-pdf";
import { parseUserAgent, detectDevTools } from "@/lib/utils";

const steps = ["读取仓库代码", "分析代码结构", "AI 生成元数据", "生成程序鉴别材料", "生成文档鉴别材料", "完成"];

/** Mark a project as interrupted so reopen shows resume UI instead of stuck "准备中". */
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
  const [codePdfUrl, setCodePdfUrl] = useState<string | null>(null);
  const [manualPdfUrl, setManualPdfUrl] = useState<string | null>(null);
  const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null);
  const [manualMarkdown, setManualMarkdown] = useState("");
  const [editingManual, setEditingManual] = useState(false);
  const [reexporting, setReexporting] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState({ softwareName: "", version: "", completedAt: "", branch: "" });
  const [forceRegenerate, setForceRegenerate] = useState(false);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchesLoadAttempted, setBranchesLoadAttempted] = useState(false);
  const [savingProject, setSavingProject] = useState(false);

  // AI 核对项目信息 / 审核说明书
  const [metaReview, setMetaReview] = useState<MetaReviewResult | null>(null);
  const [reviewingMeta, setReviewingMeta] = useState(false);
  const [metaReviewError, setMetaReviewError] = useState("");
  const [appliedIssues, setAppliedIssues] = useState<Record<string, boolean>>({});
  const [manualAudit, setManualAudit] = useState<ManualAuditResult | null>(null);
  const [auditingManual, setAuditingManual] = useState(false);
  const [auditError, setAuditError] = useState("");

  // Track live generation so unmount/close can flip PROCESSING → FAILED.
  const generatingRef = useRef(false);
  useEffect(() => {
    generatingRef.current = generating;
  }, [generating]);

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

      // Generation only runs in this tab's memory. A leftover PROCESSING status
      // means the previous session was closed/refreshed mid-run — recover to FAILED
      // so the resume / restart UI is shown instead of endless "准备中...".
      if (p.status === "PROCESSING") {
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
      });
      setManualDraft(getManualDraft(projectId));
      if (p.manualMarkdown) setManualMarkdown(p.manualMarkdown);
      // DONE / FAILED already have meta; skip auto-detect spinner on reopen
      if (p.status === "DONE" || p.status === "FAILED") setMetaReady(true);
    };
    void loadProject();
    return () => { active = false; };
  }, [projectId, session, router]);

  // If user navigates away / closes tab while generating, persist interrupted state.
  useEffect(() => {
    const onLeave = () => {
      if (!generatingRef.current) return;
      markGenerationInterrupted(projectId);
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      // SPA navigation unmount: same recovery so dashboard doesn't stay "生成中"
      if (generatingRef.current) markGenerationInterrupted(projectId);
    };
  }, [projectId]);

  // Auto-detect metadata on first visit
  useEffect(() => {
    if (!project || !accessToken || metaReady) return;

    const detectMeta = async () => {
      const { os, cores, memory } = parseUserAgent();
      setMeta((prev) => prev ? {
        ...prev,
        devHardware: `PC, ${os}, ${cores}核CPU, ${memory}GB内存`,
        runHardware: `PC, ${os}, ${cores}核CPU, ${memory}GB内存`,
        devOS: os,
      } : prev);

      if (!project.defaultBranch.trim()) {
        setError("项目未指定代码分支，请重新创建项目并选择分支");
        setMetaReady(true);
        return;
      }

      try {
        // Lightweight: only fetch tree, no file content
        const { allFilePaths, languages, estimatedLines } = await fetchRepoStats(
          accessToken, project.repoOwner, project.repoName, project.defaultBranch
        );

        const devTools = detectDevTools(allFilePaths);

        // Auto-select matching given languages
        // fetchRepoStats returns uppercase extensions: "JS", "PY", "TSX", etc.
        const extToGiven: Record<string, string> = {
          JS: "JavaScript", TS: "JavaScript", JSX: "JavaScript", TSX: "JavaScript",
          PY: "Python", JAVA: "Java", C: "C", CPP: "C++", "C++": "C++", "C#": "C#", CS: "C#",
          GO: "Go", RS: "C++", RB: "Ruby", PHP: "PHP", SWIFT: "Swift",
          KT: "Java", SCALA: "Java", DART: "C#",
          SQL: "SQL", R: "R", PERL: "Perl", LUA: "Python",
          HTML: "HTML", CSS: "JavaScript", VUE: "JavaScript", SVELTE: "JavaScript",
          SH: "Python", BASH: "Python", ASM: "Assembly",
          VB: "Visual Basic", VBS: "Visual Basic",
        };

        const autoLangs = new Set<string>();
        for (const lang of languages) {
          const mapped = extToGiven[lang.toUpperCase()] || extToGiven[lang];
          if (mapped) autoLangs.add(mapped);
        }

        setMeta((prev) => prev ? {
          ...prev,
          devTools,
          languagesGiven: Array.from(autoLangs),
          sourceLines: estimatedLines,
        } : prev);

        // Use tree paths for AI metadata — no file content download needed
        const fileTree = allFilePaths.slice(0, 50).join("\n");
        const languageStr = languages.slice(0, 5).join(", ");

        const aiResult = await callAIForText(
          buildMetadataPrompt(project.repoName, project.repoUrl, languageStr, fileTree, "")
        );

        try {
          const match = aiResult.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            setMeta((prev) => prev ? {
              ...prev,
              runPlatform: typeof parsed.runPlatform === "string" ? sanitizeSoftCopyrightText(parsed.runPlatform) : prev.runPlatform,
              runSupport: typeof parsed.runSupport === "string" ? sanitizeSoftCopyrightText(parsed.runSupport) : prev.runSupport,
              purpose: typeof parsed.purpose === "string" ? sanitizeSoftCopyrightText(parsed.purpose) : prev.purpose,
              domain: typeof parsed.domain === "string" ? sanitizeSoftCopyrightText(parsed.domain) : prev.domain,
              mainFeatures: typeof parsed.mainFeatures === "string" ? sanitizeSoftCopyrightText(parsed.mainFeatures) : prev.mainFeatures,
              technicalFeatures: typeof parsed.technicalFeatures === "string" ? sanitizeSoftCopyrightText(parsed.technicalFeatures) : prev.technicalFeatures,
            } : prev);
          }
        } catch { /* AI response not JSON, skip */ }

        updateProject(projectId, {
          meta: { ...getProject(projectId)!.meta, devTools, languagesGiven: Array.from(autoLangs), sourceLines: estimatedLines },
        });
      } catch { /* fetch failed, skip */ }

      setMetaReady(true);
    };

    detectMeta();
  }, [project, accessToken, projectId, metaReady]);

  const startGenerate = useCallback(async (opts?: { resumeManual?: boolean; freshManual?: boolean }) => {
    if (!project || !accessToken || !meta) return;
    if (!project.defaultBranch.trim()) {
      setError("项目未指定代码分支，请重新创建项目并选择分支");
      return;
    }

    const resumeManual = !!opts?.resumeManual;
    if (opts?.freshManual) {
      clearManualDraft(projectId);
      setManualDraft(null);
    }

    setGenerating(true);
    setError("");
    // Save meta before generating
    updateProject(projectId, { status: "PROCESSING", meta });
    setProject(getProject(projectId)!);

    try {
      // Step 0: Fetch files
      setStepIndex(0); setCurrentStep("正在读取仓库代码..."); setProgress(5);
      const { files, languages: langExts } = await fetchRepoFiles(
        accessToken, project.repoOwner, project.repoName, project.defaultBranch,
        (msg, pct) => { setCurrentStep(msg); setProgress(pct); }
      );

      // Step 1: Analyze
      setStepIndex(1); setCurrentStep("正在分析代码结构..."); setProgress(25);
      const languageStr = langExts.slice(0, 10).join(", ");
      const fileTree = files.slice(0, 50).map((f) => f.path).join("\n");
      const codeSummary = files.slice(0, 10).map((f) => `// ${f.path}\n${f.content.slice(0, 500)}`).join("\n\n").slice(0, 4000);
      const totalSourceLines = files.reduce((sum, f) => sum + f.content.split("\n").length, 0);
      setMeta((prev) => prev ? { ...prev, sourceLines: totalSourceLines } : prev);

      // Persist lightweight repo snapshot for AI 核对/审核 after page refresh
      updateProject(projectId, {
        reviewContext: { fileTree, languages: languageStr, codeSummary },
      });
      setProject(getProject(projectId)!);

      // Step 2: AI metadata (already done in detectMeta, just confirm)
      setStepIndex(2); setCurrentStep("正在确认元数据..."); setProgress(30);

      // Step 3: Generate code PDF (程序鉴别材料)
      setStepIndex(3); setCurrentStep("正在生成程序鉴别材料 PDF..."); setProgress(35);
      const codePDFBlob = await generateCodePDF(
        project.softwareName, project.version, files,
        (msg) => setCurrentStep(msg)
      );

      // Step 4: Generate manual PDF (文档鉴别材料)
      setStepIndex(4);
      setCurrentStep(
        resumeManual || getManualDraft(projectId)?.markdown
          ? "正在从断点接续生成文档鉴别材料..."
          : "正在按章节生成文档鉴别材料..."
      );
      setProgress(50);

      const existingDraft = getManualDraft(projectId);
      const generatedMarkdown = await generateManualMarkdown(
        project.softwareName, project.version, meta,
        project.repoUrl, languageStr, fileTree, codeSummary,
        {
          projectId,
          resumeMarkdown: resumeManual || existingDraft?.markdown ? existingDraft?.markdown : undefined,
          resumeAttempt: existingDraft?.attempt,
          resumeChapterIndex: existingDraft?.nextChapterIndex,
          onProgress: (msg) => {
            setCurrentStep(msg);
            const draft = getManualDraft(projectId);
            if (draft) setManualDraft(draft);
          },
        }
      );
      setManualMarkdown(generatedMarkdown);

      setCurrentStep("正在排版文档鉴别材料 PDF..."); setProgress(70);
      const manualPDFBlob = await generateManualPDF(
        project.softwareName, project.version, "软件著作权人", generatedMarkdown,
        (msg) => setCurrentStep(msg)
      );

      // Step 5: Done
      setStepIndex(5); setCurrentStep("生成完成！"); setProgress(100);
      clearManualDraft(projectId);
      setManualDraft(null);
      updateProject(projectId, {
        status: "DONE",
        meta: { ...meta, sourceLines: totalSourceLines },
        errorMsg: undefined,
        manualMarkdown: generatedMarkdown,
      });
      setProject(getProject(projectId)!);
      setCodePdfUrl(URL.createObjectURL(codePDFBlob));
      setManualPdfUrl(URL.createObjectURL(manualPDFBlob));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      setError(msg);
      setManualDraft(getManualDraft(projectId));
      updateProject(projectId, { status: "FAILED", errorMsg: msg });
      setProject(getProject(projectId)!);
    } finally {
      setGenerating(false);
    }
  }, [project, projectId, accessToken, meta]);

  const handleDownload = (url: string | null, filename: string) => {
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  };

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
    });
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

    setSavingProject(true);
    const branchChanged = branch !== project.defaultBranch;
    const nameChanged = softwareName !== project.softwareName;
    const versionChanged = version !== project.version;

    // Branch change OR user explicitly checked "force regenerate" means the
    // generated materials no longer apply and must be cleared.
    if (branchChanged || forceRegenerate) {
      const resetMeta: SoftwareMeta = {
        ...meta,
        sourceLines: 0,
        devTools: "",
        languagesGiven: [],
        runPlatform: "",
        runSupport: "",
        purpose: "",
        domain: "",
        mainFeatures: "",
        technicalFeatures: "",
      };
      clearManualDraft(projectId);
      setManualDraft(null);
      setManualMarkdown("");
      setCodePdfUrl(null);
      setManualPdfUrl(null);
      setMetaReady(false);

      updateProject(projectId, {
        softwareName,
        version,
        completedAt: projectDraft.completedAt,
        defaultBranch: branch,
        meta: resetMeta,
        status: "PENDING",
        errorMsg: undefined,
        manualMarkdown: undefined,
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
        meta,
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
    });
    setError("");
    setEditingProject(false);
    setSavingProject(false);
  };

  const handleReviewMeta = async () => {
    if (!project || !meta || !accessToken) return;
    setReviewingMeta(true);
    setMetaReviewError("");
    setMetaReview(null);
    try {
      const ctx = project.reviewContext;
      if (!ctx?.fileTree || !ctx?.languages) {
        throw new Error("缺少仓库上下文，请先生成一次材料");
      }
      const result = await reviewProjectMeta({
        softwareName: project.softwareName,
        version: project.version,
        repoName: project.repoName,
        repoDescription: project.repoUrl,
        languages: ctx.languages,
        fileTree: ctx.fileTree,
        meta: meta as unknown as Record<string, unknown>,
      });
      setMetaReview(result);
      setAppliedIssues({});
    } catch (e) {
      setMetaReviewError(e instanceof Error ? e.message : "核对失败，请重试");
    } finally {
      setReviewingMeta(false);
    }
  };

  const handleApplySuggestion = (field: string, suggestion: string) => {
    if (!meta) return;
    const next = { ...meta, [field]: suggestion };
    setMeta(next);
    setAppliedIssues((prev) => ({ ...prev, [field]: true }));
  };

  const handleAuditManual = async () => {
    if (!project || !meta) return;
    const md = manualMarkdown || project.manualMarkdown;
    if (!md?.trim()) {
      setAuditError("没有可审核的说明书内容");
      return;
    }
    const ctx = project.reviewContext;
    if (!ctx?.fileTree || !ctx?.languages || !ctx?.codeSummary) {
      setAuditError("缺少仓库上下文，请先生成一次材料");
      return;
    }
    setAuditingManual(true);
    setAuditError("");
    setManualAudit(null);
    try {
      const result = await auditManualMarkdown({
        softwareName: project.softwareName,
        version: project.version,
        meta: meta as unknown as Record<string, unknown>,
        languages: ctx.languages,
        fileTree: ctx.fileTree,
        codeSummary: ctx.codeSummary,
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
          <Link href="/" className="flex items-center gap-2">
            <Logo />
            <span className="text-lg font-semibold">软著通</span>
          </Link>
          <Link href="/dashboard" className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors">返回控制台</Link>
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
                  onClick={() => startGenerate({ resumeManual: true })}
                  className="px-4 py-2 text-sm bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg transition-colors"
                >
                  从断点继续
                </button>
                <button
                  onClick={() => startGenerate({ freshManual: true })}
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
                    onClick={() => { setEditingProject(false); setError(""); }}
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
                  disabled={reviewingMeta || !metaReady || !project.reviewContext}
                  className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:border-[var(--color-primary)] transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  title={!project.reviewContext ? "请先生成一次材料后再核对" : "AI 核对当前填写是否合理"}
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
              {!metaReady && <p className="text-xs text-[var(--color-primary)] mb-4">正在自动检测和生成元数据...</p>}

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
                  {metaReview.issues.length === 0 ? (
                    <p className="text-xs text-[#5C635D] pl-6">未发现明显问题。</p>
                  ) : (
                    <div className="space-y-2 pl-6">
                      {metaReview.issues.map((issue, idx) => {
                        const applied = appliedIssues[issue.field];
                        return (
                          <div
                            key={idx}
                            className={`border rounded-lg p-3 text-xs ${
                              applied
                                ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/5 opacity-60"
                                : issue.severity === "high"
                                ? "border-[var(--color-error)]/30 bg-[var(--color-error)]/5"
                                : "border-[var(--color-border)] bg-[var(--color-card)]"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <span className="font-medium text-[#1F2421]">{issue.fieldLabel}</span>
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
                            <div className="flex items-start gap-2">
                              <p className="text-[#5C635D] flex-1 min-w-0">建议：{issue.suggestion}</p>
                              {!applied && (
                                <button
                                  onClick={() => handleApplySuggestion(issue.field, issue.suggestion)}
                                  className="flex-shrink-0 px-2 py-1 text-[10px] border border-[var(--color-border)] rounded hover:border-[var(--color-primary)] transition-colors"
                                >
                                  应用
                                </button>
                              )}
                              {applied && (
                                <span className="flex-shrink-0 text-[10px] text-[var(--color-success)]">✓ 已应用</span>
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
                <EditableField label="主要功能" value={meta.mainFeatures} onChange={(v) => setMeta({ ...meta, mainFeatures: v })} placeholder="AI 生成中..." />
                <EditableField label="技术特点" value={meta.technicalFeatures} onChange={(v) => setMeta({ ...meta, technicalFeatures: v })} placeholder="AI 生成中..." />
              </div>
            </div>

            <button onClick={() => startGenerate()} disabled={!metaReady}
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
                    disabled={reexporting || !(manualMarkdown || project.manualMarkdown)}
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
                  disabled={auditingManual || !project.reviewContext}
                  className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:border-[var(--color-primary)] transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  title={!project.reviewContext ? "请先生成一次材料后再审核" : "AI 审核当前说明书质量"}
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

            <button onClick={() => { clearManualDraft(projectId); setManualDraft(null); updateProject(projectId, { status: "PENDING" }); setProject(getProject(projectId)!); setMetaReady(false); setCodePdfUrl(null); setManualPdfUrl(null); setManualMarkdown(""); }}
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
                  onClick={() => startGenerate({ resumeManual: true })}
                  className="px-6 py-3 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-lg font-medium transition-colors"
                >
                  从断点继续生成说明书
                </button>
              ) : null}
              <button
                onClick={() => startGenerate(manualDraft?.markdown ? { freshManual: true } : undefined)}
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

function EditableField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-xs text-[var(--color-muted)] mb-1">{label}</label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2}
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
  return <SessionProvider><ProjectDetailContent /></SessionProvider>;
}
