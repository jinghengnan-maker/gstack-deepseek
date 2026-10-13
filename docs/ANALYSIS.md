# 源码分析理解 —— gstack 的 Claude → DeepSeek 改造

> 面向读者：想知道"这 726 行到底改在哪、为什么这么改、有没有改坏"的人。
> 所有结论都有实测证据，见第四节。

---

## 0. 先给结论

**gstack 对 Anthropic 的耦合，比它看起来薄得多。**

一个 3600 文件的仓库，dependencies 里**没有一个 Anthropic 包**
（`@anthropic-ai/*` 全在 devDependencies，只用于付费评测）。运行时真正的耦合只有两处：

1. **去哪里找 `claude` 这个可执行文件**
2. **`api` runner 该拿谁的 key**

模型选谁、endpoint 打哪、怎么认证——**这三件事上游本来就是环境变量驱动的**。
所以这次改造的本质不是"重写后端"，而是"补上两个缺口 + 拆掉一个路障"。

改造后：**6 个文件，+726 / −25。上游的判断逻辑、拒绝逻辑、门禁逻辑一行未动。**

---

## 1. 调用链地图

gstack 里"让模型干活"有三条独立链路，改造要覆盖全部三条：

```
链路 A：主力 Agent 链路（绝大多数技能走这条）
  SKILL.md 指令
    └─> bun bin/gstack-claude-code --cwd … --access read-only --timeout-ms …
          └─> lib/claude-code.ts   claudeCodeMain()
                ├─ claudeCodeArgs()      拼 claude CLI 参数
                └─ resolveClaudeCommand()  ← lib/claude-bin.ts  【改造点 1】
                      └─ spawn("claude", args, { shell: false, env: 原样透传 })
                            └─ claude 进程读 ANTHROPIC_BASE_URL → DeepSeek

链路 B：api runner（跨家族"第二意见"）
  bun bin/gstack-outside-voice --runner api --model deepseek-reasoner
    └─> lib/outside-voice-runner.ts   ApiRunner
          ├─ available()  先问"能不能跑"       【改造点 3，5 行】
          └─ run()
                └─> lib/outside-voice-api.ts  callModel()
                      ├─ planTransport()  选 key + endpoint + wire shape  【改造点 2】
                      └─ post()  → 写 egress 回执 → fetch

链路 C：浏览器 / 无模型链路（browse、qa、scrape…）
  $B = browse/dist/browse.exe —— 不碰 LLM，零改造
```

**关键点**：链路 A 的 `lib/claude-code.ts` 把**父进程环境变量原样透传**给子进程。
这意味着只要 `claude` 进程自己能读到 DeepSeek 配置，gstack 一行都不用改。
本机 `~/.claude/settings.json` 恰好已经把 Claude Code 指向 DeepSeek 了——
所以**链路 A 本来就能跑**，改造只解决了它"找不到可执行文件"的问题。

---

## 2. 逐文件分析

### 2.1 `lib/deepseek.ts` — 新增 135 行

**职责**：把"DeepSeek 凭据从哪来"这件事收敛到一个模块。

```ts
export function resolveDeepSeekKey(env = process.env): string | undefined {
  for (const name of KEY_VARS) {                    // DEEPSEEK_API_KEY / GSTACK_DEEPSEEK_API_KEY
    const value = env[name]?.trim();
    if (value) return value;
  }
  if (env !== process.env) return undefined;        // ← 见下方「设计决策 2」
  return readDeepSeekKeyFromStore(env);             // ~/.dsh/.credentials.yaml
}
```

**为什么要有凭据库回落**：DSH 把 key 存在 `~/.dsh/.credentials.yaml`，
它导出给自己启动的进程，但 gstack 可能被任意 shell 拉起（skills 里有
`bun bin/...`、`bash bin/...` 各种调用方式）。让 gstack 自己去读那个文件，
就消除了"必须先 export 才能用"的约束。

**`applyDeepSeekEnv()` 的全部作用是"把规范变量填上"**：

```ts
set('ANTHROPIC_API_KEY', cfg.apiKey);      // outside-voice-api 只认这个
set('ANTHROPIC_AUTH_TOKEN', cfg.apiKey);   // Claude Code 认的是这个
set('ANTHROPIC_BASE_URL', cfg.anthropicBase);
set('ANTHROPIC_MODEL', cfg.model);
set('ANTHROPIC_SMALL_FAST_MODEL', cfg.model);
set('GSTACK_CLAUDE_MODEL', cfg.model);     // ← 拆路障，见「设计决策 1」
set('GSTACK_EVAL_MODEL_DISTILL', cfg.model);
```

每个 `set` 都是**有值就不覆盖**（`if (!env[name]?.trim())`）。
这条很要紧：**一个真想连 Anthropic 的会话，不会被这个模块劫持。**

### 2.2 `lib/claude-bin.ts` — 改 +88 行

这是**整条链路能不能通的唯一开关**，也是踩坑最深的地方。

#### 坑：Windows 上 npm 装的 CLI 是 `.cmd`，而 `.cmd` 不能被 spawn

npm 全局装一个 CLI，会落地三个文件：

```
C:\Users\LENOVO\AppData\Roaming\npm\claude       ← shell 脚本
C:\Users\LENOVO\AppData\Roaming\npm\claude.cmd   ← 批处理
C:\Users\LENOVO\AppData\Roaming\npm\claude.ps1   ← PowerShell（本机被执行策略禁用）
```

`Bun.which('claude')` 按 `PATHEXT` 解析，**命中的是 `.cmd`**。
然后 `child_process.spawn` 直接拒绝：

```
spawn ...claude.cmd EINVAL
```

原因是 CVE-2024-27980 之后，Node/Bun 要求 batch file 必须 `shell: true` 才能执行。
而 gstack 是**故意 `shell: false`** 的（`lib/claude-code.ts`），
因为 shell 会引入 argv 引号转义问题——**用安全换来的东西不能再换回去**。

**解法**：不碰 spawn，改为**绕过 shim 找真实可执行文件**。

```ts
function spawnableClaudeExecutable(candidate: string): string | null {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(candidate)) return candidate;
  const sibling = path.join(dir, `${stem}.exe`);            // 同目录的 .exe
  if (fs.existsSync(sibling)) return sibling;
  const installed = path.join(dir, 'node_modules', '@anthropic-ai',
                              'claude-code', 'bin', `${stem}.exe`);  // npm 全局布局
  if (fs.existsSync(installed)) return installed;
  return null;
}
```

#### 次生设计：找不到就回落到内置 shim

```ts
const which = Bun.which('claude', { PATH });
const command = which ? spawnableClaudeExecutable(which) : null;
if (command) return { command, argsPrefix: [] };

const shim = resolveDeepSeekShim(env, PATH);   // 仅当 DeepSeek key 可解析
return shim ? { command: shim, argsPrefix } : null;
```

**`Never shadows a usable claude`** 是刻意的：只有在"本来会返回 null"的位置才填坑。
一台装了真 Claude Code 的机器，行为与上游**完全一致**。

### 2.3 `lib/outside-voice-api.ts` — 改 +94/−25

三条独立的改动，每条都有理由。

#### (a) 新增 `deepseek` 家族

```ts
export const API_FAMILIES: readonly ModelFamily[] = ['openai', 'anthropic', 'deepseek'];

export function apiKeyFor(family, env) {
  if (family === 'openai' && env.OPENAI_API_KEY) return { key: …, provider: 'openai' };
  if (family === 'anthropic' && env.ANTHROPIC_API_KEY) return { key: …, provider: 'anthropic' };
  if (family === 'deepseek') {
    const key = resolveDeepSeekKey(env);
    if (key) return { key, provider: 'deepseek' };
  }
  return undefined;   // ← 保持"拒绝"这个行为
}
```

注意 `apiKeyFor` **只认 `ANTHROPIC_API_KEY`，从不读 `ANTHROPIC_AUTH_TOKEN`**——
这是上游行为，我保留了。`applyDeepSeekEnv()` 两个都设，所以两边都满足。

#### (b) 缺 key 的家族由 DeepSeek 顶上，但**不伪装**

```ts
const onDeepSeek = (shape) => {
  const id = bareModelId(model);
  const chosen = /^deepseek/.test(id) ? id
               : /reason/i.test(id) ? deepseek.reasoningModel   // deepseek-reasoner
               : deepseek.model;                                // deepseek-flash
  return { shape, base: …, key: deepseek.apiKey, provider: 'deepseek', model: chosen };
};
```

请求 `claude-sonnet-5` 会真的被送到 `deepseek-flash`——**但结果里带的是实际应答的
模型 id**，不是原来那个：

```json
{ "provider": "deepseek", "model": "deepseek-flash", … }
```

runner 用这两个字段给记录打标签，所以**跨家族评审的可信度标记不会被伪造**。
这条边界很重要：一个"假装成 Claude 的 DeepSeek"会让同族冲突检测失效。

#### (c) 真正没得救时才抛错

```ts
throw new Error(`no API key for model family ${family} (set …)`);
```

**保留了上游的错误文案**，只在末尾补上 `DEEPSEEK_API_KEY` 这个提示。

### 2.4 `lib/outside-voice-runner.ts` — 改 5 行

上游 `ApiRunner.available()` 是个白名单：

```ts
if (family === 'anthropic' && env.ANTHROPIC_API_KEY) return { ok: true };
if (family === 'openai'    && env.OPENAI_API_KEY)    return { ok: true };
return { ok: false, reason: … `no API adapter for model family ${family}` };
```

于是 `deepseek-reasoner` 在**还没发请求之前**就被拒了。补一行：

```ts
if (deepSeekAvailable(env)) return { ok: true };
```

**为什么是 5 行而不是改 `FAMILY_RULES`**：因为

```ts
// lib/outside-voice-runner.ts:59-71  —— 上游原生就有
['deepseek', /^(deepseek\/|deepseek)/],
```

上游**早就认识 deepseek 这个家族**了——它是把 DeepSeek 当**跨家族的第二意见**
来用的。我做的不是"教它认识 DeepSeek"，只是"别在门口拦着它"。

### 2.5 `bin/gstack-deepseek-claude.ts` — 新增 427 行

**这不是链路 A/B 的一部分**，是给"根本没装 Claude Code"的机器准备的独立 Agent。

它必须满足 `lib/claude-code.ts` 眼里的 `claude` 契约：

| 契约要求 | shim 的实现 |
|---|---|
| prompt 从 **stdin** 进 | `readStdin()` |
| 参数 `-p --output-format json --tools … --disallowedTools 'mcp__*'` | `parseArgs()` 全量接受 |
| stdout **恰好一行** JSON | `emit()` |
| 必须有非空 `result` 字段 | `{type:'result', subtype, is_error, result, session_id, model, provider:'deepseek', usage}` |
| 失败时 `is_error:true` / 退出码非 0 | 一致 |

**内置工具循环**是它和"裸调 API"的区别：`runTool()` 实现了 `Read`（带行号、有截断），
`Grep`（`path:line:text`），`Glob`，模型可以真的多轮调用它们。
之所以要真工具而不是让模型"假装读了文件"——实测证明 DeepSeek 支持 tool use：

```
POST https://api.deepseek.com/anthropic/v1/messages
→ 200  stop_reason: "tool_use"
   content: [ {type:"text", text:"I'll read the package.json file for you."},
              {type:"tool_use", id:"call_00_zRwmZfySnB76Alq9lkit1759",
               name:"Read", input:{path:"package.json"}} ]
```

**安全边界**（自己写的工具循环必须自己兜）：

```ts
function confine(cwd, requested) {
  // 解析后不在 cwd 之内 → throw `path escapes the working directory: <p>`
}
const SKIP_DIRS = new Set(['node_modules','.git','dist','build',
                           '.next','vendor','__pycache__','.venv','target']);
```

上限也全部写死：`MAX_TURNS_CAP = 40`、`MAX_FILE_BYTES = 512*1024`、
`MAX_GREP_HITS = 250`、`MAX_GLOB_HITS = 500`、`READ_LINE_CAP = 4000`。

**模型 id 降解**：如果上游目录塞给它一个 `claude-opus-5-5`，它不会 404：

```ts
function resolveModel(requested, fallback) {
  // 非 deepseek* → 用配置的模型，并在 stderr 说明：
  // 'requested model "X" is not served by DeepSeek; using Y'
}
```

**只降级，不撒谎**——stderr 说清楚发生了什么。

---

## 3. 三个设计决策

### 决策 1：遇到"自定义提供商"路障，绕过去而不是拆掉它

**这是最容易改错的地方。** `lib/model-policy.ts:433`：

```ts
if (nonDefaultUrl(values.ANTHROPIC_BASE_URL, 'https://api.anthropic.com'))
  signals.push(...);   // → 判定为 custom provider
```

只要你把 `ANTHROPIC_BASE_URL` 设成 DeepSeek，gstack 就认为你在接自定义提供商，
接着在选模型时**抛错**。而 `resolvePlanReviewModel`（`lib/model-policy.ts:522-581`）
的解析顺序是：

```
显式 --model
  → 环境变量 GSTACK_CLAUDE_MODEL      (:543-548)   ← 在这里就满足了
  → tier === 'host' 委派              (:549-556)
  → config.yaml 覆盖                  (:557-561)
  → custom-provider 抛错              (:563-574)   ← 到不了这里
  → 目录查询                          (:575-580)
```

**`GSTACK_CLAUDE_MODEL` 排在抛错之前。** 所以正确做法是"在它之前把模型名填上"，
而不是"去改那个判断"。改判断会波及所有真正接自定义网关的用户；
填环境变量只影响自己。**顺着设计走，别跟它对着干。**

### 决策 2：显式传入的 env 对象 = 全部环境，绝不回落读盘

```ts
if (env !== process.env) return undefined;   // lib/deepseek.ts:79
if (env !== process.env) return undefined;
```

上游有 `test/helpers/hermetic-env.ts`（密封测试环境），如果 `resolveDeepSeekKey`
在收到测试传入的 env 时还去 `os.homedir()` 读真实凭据库，
**一把真实的 key 就会泄漏进密封测试**。这是个必须在写代码时就想到的边界。

### 决策 3：不设任何用户级环境变量

**被否决的方案**：把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 写进
Windows 用户级环境变量，一劳永逸。

**否决理由**：这会**劫持未来任何一次真实的 Claude Code 安装**。
用户哪天想用真的 Claude，会发现它莫名指向 DeepSeek。

**采用的方案**：让代码自给自足（shim 和 `lib/deepseek.ts` 自己找 key），
**一个环境变量都不设**。真实 Claude Code 若存在，它就是主力，行为与上游一致。

---

## 4. 验证证据

| # | 验证项 | 命令 | 实际输出 |
|---|---|---|---|
| 1 | 主干链路端到端 | `bun bin/gstack-claude-code --cwd <root> --access read-only --timeout-ms 180000 --user-invoked` | `{"status":"completed","provider":"claude-code","result":"REVIEWER ONLINE","session_id":"1a80800f-…","usage":{"input_tokens":12439,"output_tokens":5},"modelUsage":{"deepseek-flash":{…}},"exit_code":0}` |
| 2 | `api` runner · DeepSeek 家族 | `--runner api --model deepseek-reasoner` | 退出 0，`provider: deepseek`，model `deepseek-reasoner`，egress 回执 host `api.deepseek.com` |
| 3 | `api` runner · 无 key（回归） | 清空所有 key | 退出 3，**上游原文拒绝**——契约未破坏 |
| 4 | `api` runner · 同族冲突 | 内外都用 anthropic 家族 | 照常拦截 |
| 5 | 模型 id 降解 | 请求 `claude-sonnet-5` | 实际由 DeepSeek 应答，记录写 `deepseek-flash`（不伪装） |
| 6 | 浏览器引擎 | `browse.exe goto/text/screenshot/console` | 200 / 正文 / 39KB PNG / 无控制台消息 |
| 7 | DSH 技能扫描 | 扫描 `~/.dsh/skills` | 61 个技能，60 个技能名，零重名 |
| 8 | 类型检查 | `bun run typecheck` | 通过 |

**第 3 项最有说服力**：改造后，"没有 key 时该拒绝"这个行为**和上游一字不差**。
说明这次改的是"补通道"，不是"拆门禁"。

---

## 5. 没做的事（边界）

| 项目 | 为什么没做 |
|---|---|
| `lib/context-bill.ts` 的 `count_tokens` | DeepSeek 没有这个接口；`--exact` 会 404 并**自动回落到离线估算**，仅影响精确度 |
| `lib/pricing.ts` 的价格表 | 只用于成本报告。**报告里的钱是 Anthropic 价，不是 DeepSeek 价**——看数字时要知道 |
| `lib/eval-model.ts` 的 `claude-haiku-4-5` | 付费评测专用，已由 `applyDeepSeekEnv()` 通过 `GSTACK_EVAL_MODEL_DISTILL` 改写 |
| `hosts/claude.ts` 的 `defaultModel = 'claude'` | 这个值会被渲染进每个生成的 `SKILL.md`。改它意味着改模板 + 重新生成 61 个文件，收益为零 |
| `lib/diagram-render` 的 `gpt-5.5` | 走 `OPENAI_BASE_URL`，与 DeepSeek 无关 |

---

## 6. 一句话总结

> **上游把"用哪个模型"设计成了环境变量，把"怎么找 claude"写死成了代码。**
> **所以改造的力气几乎全花在后者——而那恰恰是个 Windows 的 `.cmd` 坑，
> 不是 Anthropic 的坑。**

换句话说：这次改造解决的**主要是平台问题，其次才是供应商问题**。
