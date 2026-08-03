# AI 服务端代理 + 模型发现 + 模型测试（缩小范围）实施计划

> **For Claude:** 逐任务实施。每个任务先写失败测试，再实现，跑测试和 lint/build。**不要执行 git commit**，除非用户明确要求。

**Goal:** 修复 502 `代理请求失败…Failed to fetch` 的根因（浏览器 Service Worker 跨域调用），把所有 AI 供应商请求改为经过认证的 Next.js 服务端接口，并新增供应商模型列表获取与真实最小生成测试。

**明确排除（本次不做）:** 账户级数据库、Prisma/Turso、API Key 加密存储、GitHub 身份落库、localStorage 迁移。AI 配置仍然只保存在浏览器 localStorage。

**Architecture:** 浏览器保留提示词构造、章节编排和断点草稿逻辑，但不再直连供应商。客户端把 `protocol/baseUrl/model/apiKey` 连同请求内容一起发到同源认证接口；服务端构造上游 URL 与鉴权头、校验出站地址、调用协议适配器、归一化响应与错误。API Key 只在单次请求内存中使用，服务端不落库、不记录。

**Tech Stack:** Next.js 16.2.9 App Router Route Handlers（Node.js runtime）、React 19.2.4、Auth.js v5（现有 JWT 会话）、Node `crypto`/`dns`、undici、Zod、Vitest、Testing Library、TypeScript 5。

**安全边界（已确认）:**

- 所有 AI 接口要求 GitHub 登录（`auth()`），未登录返回 401。
- 客户端只能提交 `protocol`（枚举）、`baseUrl`、`model`、`apiKey`、`messages`、`maxTokens`；**不能**提交任意路径、任意 header、任意 HTTP 方法。
- 生产环境禁止回环、私网、链路本地、云元数据和保留地址；开发环境可用显式环境变量放行。
- 不自动跟随重定向。
- 日志和错误响应中不得出现 API Key、完整 prompt、URL query。

**必读（项目要求）:** 修改框架代码前先读已安装文档：

- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/02-guides/authentication.md`（Route Handler 必须自行鉴权）
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/runtime.md`

**已知基线（用户已同意记录后继续）:**

- `npm run build` 通过。
- `npm run lint` 有 6 个既有 error（`scripts/bump-version.cjs`、`scripts/gen-changelog.cjs` 的 `@typescript-eslint/no-require-imports`）和 1 个既有 warning（`AISettingsModal.tsx:34` useMemo 依赖）。
- `npm install` 造成 `package-lock.json` 根 version 0.1.0→0.1.8 漂移。

---

## 任务 1：建立测试框架

**Files:**

- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `src/test/smoke.test.ts`

### Step 1: 安装依赖

```bash
npm install zod undici
npm install --save-dev vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

添加脚本，不改动已有脚本语义：

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

### Step 2: 配置 Vitest

`vitest.config.ts`：`@` 别名指向 `src`，`environment: "node"`，`setupFiles: ["./vitest.setup.ts"]`，`clearMocks`/`restoreMocks` 为 true，v8 coverage 只统计 `src/lib/ai/**`、`src/lib/server/**`、`src/app/api/ai/**`。

`vitest.setup.ts`：`import "@testing-library/jest-dom/vitest";`

组件测试用文件顶部 `// @vitest-environment jsdom`，服务端测试保持 node 环境。

### Step 3: 冒烟测试

`src/test/smoke.test.ts` 断言 `@/lib/ai/contracts` 之外的既有模块可通过别名导入（例如 `@/lib/utils`，避免依赖 `window` 的 `storage.ts`）。

Run: `npm test`
Expected: PASS。

### Step 4: 检查点

```bash
npm test
npm run lint
npm run build
```

新增文件不得引入新的 lint 错误。不要 commit。

---

## 任务 2：出站地址安全策略

**Files:**

- Create: `src/lib/server/ai/outbound-policy.ts`
- Create: `src/lib/server/ai/outbound-policy.test.ts`
- Create: `src/lib/server/ai/safe-fetch.ts`
- Create: `src/lib/server/ai/safe-fetch.test.ts`

### Step 1: 先写失败测试

`outbound-policy.test.ts` 至少覆盖：

- 接受公网 HTTPS（IPv4 与 IPv6）。
- 拒绝 `localhost`、`*.localhost`、`.local`、`127.0.0.0/8`、`0.0.0.0`、`169.254.0.0/16`（含 `169.254.169.254` 云元数据）。
- 拒绝 RFC1918（10/8、172.16/12、192.168/16）、CGNAT（100.64/10）、多播、文档（192.0.2/24 等）、benchmark（198.18/15）、保留段。
- 拒绝 IPv6 回环 `::1`、未指定 `::`、ULA `fc00::/7`、链路本地 `fe80::/10`、多播 `ff00::/8`，以及 IPv4-mapped 私网 `::ffff:10.0.0.1`。
- 拒绝 URL 中含 username/password。
- 拒绝非 `http:`/`https:` 协议。
- HTTP 允许但返回 `insecureHttp: true` 警告标记。
- DNS 解析出的**任一**地址落在禁止范围即整体拒绝。
- 仅当 `NODE_ENV !== "production"` 且 `AI_ALLOW_PRIVATE_NETWORK === "true"` 时放行私网；`NODE_ENV=production` 时该开关无效。
- 错误信息只含主机名，不含 path/query。

测试必须注入 `lookup` 函数，**不得**触发真实 DNS。

Run: `npm test -- src/lib/server/ai/outbound-policy.test.ts`
Expected: FAIL（模块不存在）。

### Step 2: 实现

```ts
export interface ValidatedTarget {
  url: URL;
  addresses: string[];
  insecureHttp: boolean;
}

export async function validateOutboundTarget(
  rawUrl: string,
  options?: { lookup?: LookupFunction }
): Promise<ValidatedTarget>;
```

用 `dns.promises.lookup(host, { all: true, verbatim: true })`，返回校验通过的地址供传输层固定使用。

### Step 3: safe-fetch 失败测试

覆盖：

- 请求只连到已校验过的地址（自定义 `undici.Agent` 的 `lookup`）。
- Host/SNI 仍为原始主机名。
- `redirect: "manual"`，3xx 不自动跟随，返回结构化错误。
- 超时映射为 `UPSTREAM_TIMEOUT`。
- 响应体（含流）仍可正常消费；dispatcher 在流生命周期结束后才关闭。
- 不接受调用方传入的 dispatcher。

### Step 4: 实现 safeFetch

```ts
export async function safeFetch(
  rawUrl: string,
  init: RequestInit & { timeoutMs: number }
): Promise<Response>;
```

出站请求使用 undici 而非 Next 扩展 fetch，因为需要自定义 DNS `lookup`。浏览器同源请求仍用普通 fetch + `cache: "no-store"`。

Run: `npm test -- src/lib/server/ai/outbound-policy.test.ts src/lib/server/ai/safe-fetch.test.ts`
Expected: PASS。

---

## 任务 3：共享契约、错误码与响应解析

**Files:**

- Create: `src/lib/ai/contracts.ts`
- Create: `src/lib/server/ai/errors.ts`
- Create: `src/lib/server/ai/errors.test.ts`
- Create: `src/lib/server/ai/response-parser.ts`
- Create: `src/lib/server/ai/response-parser.test.ts`

### Step 1: 客户端安全契约

`src/lib/ai/contracts.ts` 不含任何服务端依赖和密钥：

```ts
export type AIProtocol = "openai" | "claude" | "gemini";
export type AIMessage = { role: "system" | "user" | "assistant"; content: string };
export type AICompletion = { text: string; finishReason: string };
export type AIModelOption = {
  id: string;
  displayName?: string;
  description?: string;
  capabilities?: string[];
};
```

同时定义结构化错误载荷与归一化 SSE 事件（`delta`/`done`/`error`）。

### Step 2: 错误码归一化（先写失败测试）

错误码至少包含：

`AUTH_REQUIRED`、`INVALID_REQUEST`、`INVALID_BASE_URL`、`PRIVATE_ADDRESS_BLOCKED`、`UPSTREAM_AUTH_FAILED`、`MODEL_NOT_FOUND`、`MODEL_LIST_UNSUPPORTED`、`UPSTREAM_RATE_LIMITED`、`UPSTREAM_TIMEOUT`、`UPSTREAM_UNREACHABLE`、`UPSTREAM_HTTP_ERROR`、`INVALID_UPSTREAM_RESPONSE`。

映射规则：401/403 → `UPSTREAM_AUTH_FAILED`；模型相关 404/错误体 → `MODEL_NOT_FOUND`；429 → `UPSTREAM_RATE_LIMITED`；超时 → `UPSTREAM_TIMEOUT`；DNS/连接/TLS → `UPSTREAM_UNREACHABLE`；其他非 2xx → `UPSTREAM_HTTP_ERROR`；响应无法解析 → `INVALID_UPSTREAM_RESPONSE`。

上游响应体截断到有限长度；不得回传请求头、凭据、完整 HTML 错误页或堆栈。

### Step 3: 迁移响应解析（先写失败测试）

把 `src/lib/ai-helpers.ts:157-326` 的 payload 提取与 JSON/SSE/NDJSON/heartbeat 解析迁到服务端。测试覆盖：

- 普通 JSON 完成响应。
- SSE `data:` 增量与 `[DONE]`。
- Claude content blocks、`content_block_delta`、`message_delta`、`message_stop`。
- Gemini candidates。
- `: heartbeat` 注释行、`event:`/`id:`/`retry:` 行。
- 供应商错误对象。
- 畸形分片在仍有有效内容时跳过。
- 空响应或完全无效的成功响应 → `INVALID_UPSTREAM_RESPONSE`（**不再**静默返回空字符串）。

Run: `npm test -- src/lib/server/ai/errors.test.ts src/lib/server/ai/response-parser.test.ts`
Expected: PASS。

---

## 任务 4：三协议适配器

**Files:**

- Create: `src/lib/server/ai/adapters/types.ts`
- Create: `src/lib/server/ai/adapters/openai.ts` + `.test.ts`
- Create: `src/lib/server/ai/adapters/claude.ts` + `.test.ts`
- Create: `src/lib/server/ai/adapters/gemini.ts` + `.test.ts`
- Create: `src/lib/server/ai/adapters/index.ts`

### Step 1: 统一接口

```ts
export interface ProviderRuntimeConfig {
  protocol: AIProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ProviderAdapter {
  listModels(config, options): Promise<AIModelOption[]>;
  generate(config, messages, options): Promise<AICompletion>;
  stream(config, messages, options): Promise<ReadableStream<Uint8Array>>;
}
```

`index.ts` 按已校验的 protocol 选择适配器，未知值直接拒绝。

### Step 2: 先写 URL/请求失败测试

OpenAI 兼容：

- 根地址 → `/v1/chat/completions`、`/v1/models`。
- 以 `/v1` 或 `/v4` 结尾 → 直接拼接，不重复版本段。
- 以 `/chat/completions` 结尾 → 生成 URL 不变，模型列表从版本根推导。
- Bearer 鉴权、`max_tokens`、`stream` 标记正确。

Claude：

- 根地址与 `/v1` 结尾都能正确得到 `/v1/messages`、`/v1/models`。
- 使用 `x-api-key` + `anthropic-version`。
- 服务端**不**发送 `anthropic-dangerous-direct-browser-access`。
- system 消息与对话消息正确分离。

Gemini：

- 根地址与已含 `/v1beta` 都不重复拼接（修复现有 `ai-helpers.ts:367,1911` 的重复风险）。
- 模型 ID 安全编码。
- 列表路径 `/v1beta/models`，过滤 `supportedGenerationMethods` 不含 `generateContent` 的条目。
- 返回的 `models/foo` 归一化为 `foo`。
- assistant→model、systemInstruction 映射正确。

### Step 3: 归一化流式输出

适配器消费上游各家流格式，输出本站稳定 SSE：

```text
event: delta
data: {"text":"..."}

event: done
data: {"finishReason":"stop"}
```

首个 delta 之前失败 → 结构化错误；已经输出 delta 之后失败 → 发出 error 事件，**不重放**。

Run: `npm test -- src/lib/server/ai/adapters`
Expected: PASS。

---

## 任务 5：模型列表与模型测试接口

**Files:**

- Create: `src/lib/server/ai/request-schema.ts`
- Create: `src/lib/server/ai/request-schema.test.ts`
- Create: `src/lib/server/ai/require-session.ts`
- Create: `src/app/api/ai/models/route.ts`
- Create: `src/app/api/ai/test/route.ts`
- Create: `src/app/api/ai/diagnostics-route.test.ts`

### Step 1: Zod 请求校验（先写失败测试）

供应商凭据请求体：

```ts
{
  protocol: "openai" | "claude" | "gemini";
  baseUrl: string;   // 有界长度，去尾斜杠
  model?: string;    // 模型列表时可选
  apiKey: string;    // 有界长度
}
```

测试覆盖：未知 protocol 拒绝、超长字段拒绝、空 apiKey 拒绝、baseUrl 非法拒绝、额外未知字段被剥离（不得透传任意 header/method/path）。

### Step 2: 鉴权助手

`require-session.ts` 调用 `auth()`，未登录抛出 `AUTH_REQUIRED`。每个 Route Handler 在任何出站请求前调用它。加 `export const runtime = "nodejs"`。

### Step 3: `POST /api/ai/models`

- 鉴权 → 校验请求 → 校验出站地址 → 适配器 `listModels`。
- 较短超时（约 15s）。
- 结果去重、稳定排序、限制条数与响应体积。
- 供应商不支持列表时返回 `MODEL_LIST_UNSUPPORTED`，**不影响**用户手动输入模型。

### Step 4: `POST /api/ai/test`

- 固定最小提示（如 `仅回复 OK`）与极小输出预算；**不接受**用户自定义 prompt。
- 返回 `{ ok, provider, model, latencyMs, output, warning? }`，`output` 截断。
- HTTP 明文时带 warning。
- 不保存、不启用任何配置。

### Step 5: 结构化错误响应

统一返回：

```ts
{ error: { code, message, suggestion, status?, host?, requestId } }
```

响应头 `Cache-Control: no-store`。

### Step 6: Route Handler 测试

覆盖未登录 401、请求体非法 400、上游各类失败的错误码映射、响应不含 apiKey。

Run:

```bash
npm test -- src/lib/server/ai/request-schema.test.ts src/app/api/ai/diagnostics-route.test.ts
npm run lint
npm run build
```

Expected: PASS。

---

## 任务 6：服务端生成接口

**Files:**

- Create: `src/app/api/ai/generate/route.ts`
- Create: `src/app/api/ai/stream/route.ts`
- Create: `src/app/api/ai/generation-route.test.ts`

### Step 1: 先写失败测试

覆盖：

- 未登录 → 401。
- 请求体只接受 `{ protocol, baseUrl, model, apiKey, messages, maxTokens? }`；多余字段被剥离。
- 消息条数、单条长度、总体积有上限。
- `maxTokens` 被夹到服务端允许区间。
- 非流式返回归一化 completion。
- 流式返回 `text/event-stream` + `Cache-Control: no-store, no-transform`，事件为归一化 delta/done。
- 浏览器 abort 能取消上游请求。
- 上游 401/404/429/超时映射到正确错误码。
- 日志不含 prompt 与 apiKey。

### Step 2: 实现

`/api/ai/generate` 非流式；`/api/ai/stream` 流式，不在 handler 内缓冲整个响应，取消信号向下传递。

服务端重试只针对首字节之前的连接类错误、429 和可恢复 5xx，有限次退避；400/401/403/404/422 不重试；已输出内容后不重放。

Run:

```bash
npm test -- src/app/api/ai/generation-route.test.ts
npm run lint
npm run build
```

Expected: PASS。

---

## 任务 7：迁移浏览器 AI 调用

**Files:**

- Create: `src/lib/ai/client.ts` + `src/lib/ai/client.test.ts`
- Modify: `src/lib/ai-helpers.ts:1,78-155,157-326,335-396,1866-2014`
- 受影响调用方（行为保持不变）：
  - `src/app/projects/new/page.tsx:103-150`
  - `src/app/projects/[id]/page.tsx:374-438,551-563,1060,1214,1285-1353`
  - `src/components/ReviewRulesModal.tsx:101-103`

### Step 1: 同源客户端（先写失败测试）

```ts
export async function generateAI(messages: AIMessage[], maxTokens: number): Promise<AICompletion>;
export async function streamAI(messages: AIMessage[], maxTokens: number): Promise<AICompletion>;
```

内部从 localStorage 读取当前启用配置并附带凭据，使用 `credentials: "same-origin"`、`cache: "no-store"`。

测试覆盖：请求只发往同源 `/api/ai/*`；结构化 JSON 错误转为可读错误；SSE delta 拼接与 finishReason 捕获；error 事件正确抛出；abort 传播；401 给出「请重新登录」类提示。

### Step 2: 删除坏掉的传输层

从 `ai-helpers.ts` 删除：`proxyFetch()`、`ensureAIProxyReady()`、客户端 URL/header/body 构造、客户端响应解析。

`callAIForText()` 改用 `generateAI()`；`callAILong()` 改用 `streamAI()`。

保留：提示词构造、确定性审查、术语净化、章节编排、合并去重、进度文案。

### Step 3: 保持断点与重试语义

重试分类改用结构化错误码，不再正则匹配 `AI API 错误 (...)` 文案：

- 认证/配置/模型/参数错误立即失败。
- 首字节前的网络/429/可恢复 5xx 有限重试。
- 保留 `ai-helpers.ts:2514-2551` 的章节级 try/catch 与 `persist(ci, false)`。
- 中断信息仍为 `说明书生成中断于「第一章 软件概述」（已保存草稿 0 行，可从断点继续）：<结构化错误>`。

### Step 4: 回归测试

- 首章前 `UPSTREAM_UNREACHABLE` → 草稿 0 行且可续。
- 部分章节后流失败 → 部分文本已持久化。
- 首字节前可重试错误 → 出现重试提示。
- 认证/模型错误 → 不做无意义重试。
- 续写不重复章节。

Run:

```bash
npm test
npm run lint
npm run build
```

Expected: PASS，且 `ai-helpers.ts` 不再构造供应商 URL/鉴权头。

---

## 任务 8：改造 AI 设置界面

**Files:**

- Create: `src/lib/ai/provider-diagnostics-client.ts` + `.test.ts`
- Modify: `src/components/AISettingsModal.tsx`
- Create: `src/components/AISettingsModal.test.tsx`

### Step 1: 诊断客户端（先写失败测试）

`fetchModels(form)`、`testModel(form)` 调用同源接口，解析结构化错误。

### Step 2: 弹窗交互（先写失败测试，jsdom）

- 「获取模型」使用**当前未保存**的 protocol/baseUrl/apiKey。
- 模型控件：可搜索下拉 + 保留手动输入；列表失败后仍可手输。
- protocol/baseUrl/apiKey 变化后，旧模型列表与测试结果标记过期。
- 「测试模型」发真实最小请求，显示供应商/模型/耗时/截断输出；不保存、不启用。
- 列表与测试各自独立的 loading/成功/失败状态。
- 错误按错误码给出可操作中文提示。
- 保存与保存并启用行为不变。

### Step 3: 实现

在现有编辑态基础上增加模型列表状态、测试状态与两个按钮。API Key 仍为 password 输入并存 localStorage（本次范围内不改存储位置），但界面文案要说明密钥会经本站服务器转发给供应商。

Run:

```bash
npm test -- src/lib/ai/provider-diagnostics-client.test.ts src/components/AISettingsModal.test.tsx
npm run lint
npm run build
```

Expected: PASS。

---

## 任务 9：退役 Service Worker、修正文案、最终验证

**Files:**

- Modify: `src/app/layout.tsx:1-25`
- Create: `src/components/AIWorkerCleanup.tsx` + `.test.tsx`
- Delete: `public/ai-worker.js`
- Modify: `src/app/page.tsx`（协议与首页/页脚文案）
- Create: `.env.example`
- Modify: `README.md`

### Step 1: 清理组件（先写失败测试）

`AIWorkerCleanup` 在 hydration 后调用 `navigator.serviceWorker.getRegistrations()`，只注销脚本 URL 匹配 `/ai-worker.js` 的注册；不影响其他 SW；API 不可用或注销失败时不报错。

### Step 2: 移除注册与代理

删除 `layout.tsx` 中的 `next/script` 注册；渲染 `AIWorkerCleanup`；删除 `public/ai-worker.js`。

### Step 3: 修正隐私文案

现有文案称「纯前端架构」「API Key 不会被传输」，改造后不再成立。需要如实说明：

- 代码分析与文档生成仍在浏览器完成，但提示词与代码摘要会经本站服务器转发给你选择的 AI 供应商。
- API Key 保存在浏览器本地，调用时会随请求发送到本站服务器，仅用于当次转发，不落库、不记录。
- 不得声称端到端加密或服务器无法接触密钥。

### Step 4: 静态检查

```bash
rg -n "__ai_proxy__|X-AI-Proxy|ensureAIProxyReady|navigator\.serviceWorker\.register" src public
```

Expected: 无运行时残留。

### Step 5: 环境与文档

`.env.example` 仅含占位：`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`AUTH_SECRET`、`AI_ALLOW_PRIVATE_NETWORK=false`（仅开发）。

README 说明新的调用链、安全边界和本次未做的账户级存储。

### Step 6: 全量验证

```bash
npm test
npm run lint
npm run build
```

`lint` 只应剩已知基线问题。

### Step 7: 人工验收

1. GitHub 登录。
2. 打开 AI 设置，填入真实可用的 OpenAI 兼容地址与密钥。
3. 点「获取模型」，搜索并选择模型；再验证手动输入仍可用。
4. 点「测试模型」，确认返回供应商/模型/耗时/输出。
5. 生成「第一章 软件概述」，确认不再出现 `代理请求失败…Failed to fetch`。
6. 中途中断后从断点继续，确认不重复章节。
7. 浏览器网络面板：无 `/__ai_proxy__`，无直连供应商且携带密钥的请求。
8. 未登录调用 `/api/ai/*` 返回 401。
9. 生产模式下填内网地址返回 `PRIVATE_ADDRESS_BLOCKED`。
10. 服务器日志无密钥、无完整 prompt。

若无真实供应商凭据，必须明确记录「mock 验证已完成，真实端到端未执行」，不得声称已验证。

### Step 8: 最终 diff 审查

```bash
git status --short
git diff --stat
git diff --check
```

只应包含计划内文件；无 `.env`、无密钥、无空白错误；**不创建 commit**。

---

## 顺序与检查点

按任务 1→9 执行。任务 5、6、8、9 完成后必须跑 `npm run build`，因为 Next.js 服务端/客户端边界错误常常不会在单元测试中暴露。

## 本次明确非目标

- 账户级数据库、Prisma/Turso、迁移。
- API Key 加密与密钥轮换。
- GitHub 身份落库、跨设备同步。
- 把 GitHub `repo` token 移到服务端。
- 强制模型必须来自列表。
- 流式已输出后的自动重放。
