# gstack-deepseek

**让 [gstack](https://github.com/garrytan/gstack) 跑在 DeepSeek 上。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Upstream](https://img.shields.io/badge/upstream-v1.91.95-blue.svg)](https://github.com/garrytan/gstack)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](#平台说明)
[![Diff](https://img.shields.io/badge/diff-6%20files%20%C2%B7%20%2B726%20%2F%20%E2%88%9225-informational.svg)](patch/gstack-deepseek-port.patch)

gstack 是 Garry Tan 的「虚拟工程团队」——**57 个技能**，从产品评审到发版上线，
整套工序全是 Markdown。**本项目不动它的任何一条判断逻辑，只把后端
从 Claude Code / Anthropic 换成 DeepSeek。**

> 上游 3600 个文件，`dependencies` 里**没有一个 Anthropic 包**。
> 运行时真正的耦合只有两处：**去哪里找 `claude` 可执行文件**，
> 和 **`api` runner 该拿谁的 key**。这个项目补的就是这两个缺口。

---

## 目录

- [这是什么](#这是什么)
- [快速开始](#快速开始)
- [改了什么](#改了什么)
- [原理：三个坑](#原理三个坑)
- [实测结果](#实测结果)
- [测试与 CI](#测试与-ci)
- [已知限制](#已知限制)
- [平台说明](#平台说明)
- [归属与许可](#归属与许可)

---

## 这是什么

**给谁用**：想用 gstack 但不想开 Anthropic 账号的人；已经有 DeepSeek key、
想把整套工程流程接上去的团队。

**给你什么**：

- gstack 的 57 个技能全部可用，判断逻辑与上游**逐字一致**
- 主力 Agent 链路、`api` 跨家族评审链路、浏览器链路**三条全部跑通**
- 一个可选的独立 Agent（`bin/gstack-deepseek-claude`），
  在**没装 Claude Code** 的机器上当兜底
- 没有 key 时**该拒绝就拒绝**，行为与上游一字不差（见[实测](#实测结果)第 3 项）

**不给你什么**：不修改上游的模型选型策略、门禁、安全边界。
这不是「另一个 gstack」，是**一层薄薄的后端适配**。

---

## 快速开始

### 前置

| 依赖 | 说明 |
|---|---|
| [Bun](https://bun.sh) ≥ 1.4.2 | 上游硬性要求 |
| Node.js ≥ 20 | 主要是 Windows 需要 |
| Git | |
| Git Bash / MSYS | **仅 Windows**：上游 `./setup` 是 bash 脚本 |
| DeepSeek API key | <https://platform.deepseek.com> |

### 安装

```bash
# 1. 拿到上游（浅克隆即可）
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.gstack-src
cd ~/.gstack-src

# 2. 打上 DeepSeek 补丁
git apply /path/to/gstack-deepseek/patch/gstack-deepseek-port.patch

# 3. 构建（编译 browse / design / pdf 等二进制）
bun install
bash scripts/build.sh

# 4. 装进你的 Agent
./setup
```

Windows 用户可以直接用脚本：

```powershell
.\install.ps1 -Target "$HOME\.gstack-src"
```

macOS / Linux：

```bash
./install.sh ~/.gstack-src
```

> **安装脚本说明**：这两个脚本是把本机手动安装过程脚本化，
> 参考实现见下文。**未在全新机器上端到端验证过**，遇到问题请提 issue。

### 配置 key

**唯一必需的一步**——让某个地方存在 `DEEPSEEK_API_KEY`：

```bash
export DEEPSEEK_API_KEY=sk-...
```

或者写进凭据库（本项目的解析顺序）：

```
$DSH_HOME/.credentials.yaml     # DeepSeek Harness
~/.dsh/.credentials.yaml
~/.gstack/credentials.yaml
```

格式就是一行：

```yaml
DEEPSEEK_API_KEY: sk-...
```

**不需要**设置 `ANTHROPIC_*`——代码会自己推导。
`install.ps1` / `install.sh` 也不会替你设，原因见
[原理 · 决策 3](docs/ANALYSIS.md#决策-3不设任何用户级环境变量)。

> 如果你已经装了 Claude Code，把它指向 DeepSeek 会更省事
> （`~/.claude/settings.json`），gstack 会直接复用那个 CLI。

---

## 改了什么

| 文件 | 类型 | 说明 |
|---|---|---|
| `lib/deepseek.ts` | **新增** 135 行 | key / 端点 / 模型解析 |
| `lib/claude-bin.ts` | 改 +88 | 绕开 Windows `.cmd` 包装，找到真正能 spawn 的可执行文件 |
| `lib/outside-voice-api.ts` | 改 +94/−25 | 新增 `deepseek` 传输通道；缺 key 的家族由 DeepSeek 顶上（但**不伪装**） |
| `lib/outside-voice-runner.ts` | 改 **5 行** | 别在门口拦着 `deepseek` 家族 |
| `bin/gstack-deepseek-claude.ts` | **新增** 427 行 | 独立 Agent，直接对 DeepSeek API 说 `claude -p` 协议 |

```
6 files changed, 726 insertions(+), 25 deletions(-)
```

**上游所有的拒绝逻辑、门禁逻辑、同族冲突检测——一行未动。**

改动后的完整文件在 [`src/`](src/)，补丁在
[`patch/gstack-deepseek-port.patch`](patch/gstack-deepseek-port.patch)。

---

## 原理：三个坑

完整分析见 **[docs/ANALYSIS.md](docs/ANALYSIS.md)**。这里是摘要。

### 坑 1：Windows 上 `spawn` 不了 npm 装的 CLI

npm 全局装 CLI 会落地 `claude` / `claude.cmd` / `claude.ps1` 三个文件，
`Bun.which()` 命中的是 `.cmd`，然后：

```
spawn ...claude.cmd EINVAL
```

CVE-2024-27980 之后 Node/Bun 要求 batch file 必须 `shell: true`，
而 gstack 是**故意 `shell: false`** 的（避免 argv 引号问题）。
**不能为了跑通把安全换回去**——所以改成绕过 shim 找真实 `.exe`。

### 坑 2：设了 `ANTHROPIC_BASE_URL` 就被当成「自定义提供商」

`lib/model-policy.ts:433` 只要发现 base URL 不是官方地址就拒绝选模型。
但它的解析顺序里，环境变量 `GSTACK_CLAUDE_MODEL` **排在抛错之前**：

```
显式 --model → GSTACK_CLAUDE_MODEL → tier=host → config.yaml → 抛错 → 目录
                                  ↑ 在这里就满足了
```

所以正确做法是**在它之前把模型名填上**，而不是去改那个判断——
改判断会波及所有真接自定义网关的用户。

### 坑 3：密封测试里不能读真实凭据库

```ts
if (env !== process.env) return undefined;   // lib/deepseek.ts:79
```

上游有 `test/helpers/hermetic-env.ts`。如果收到显式传入的 env 还去
`os.homedir()` 读盘，**一把真实 key 就会泄漏进密封测试**。

---

## 实测结果

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 主干 `claude-code` 链路 | `{"status":"completed","result":"REVIEWER ONLINE","modelUsage":{"deepseek-flash":…}}` |
| 2 | `api` runner · DeepSeek 家族 | 退出 0，`provider: deepseek`，有出网凭据回执 |
| 3 | `api` runner · 无 key | **上游原文拒绝，退出码 3**（契约未被破坏） |
| 4 | `api` runner · 同族冲突 | 照常拦截 |
| 5 | 模型 id 降解 | 请求 `claude-sonnet-5` → 由 DeepSeek 应答，记录写 `deepseek-flash`，**不伪装** |
| 6 | 浏览器引擎 | `goto` 200 / `text` / `screenshot` 39KB PNG / `console` 全通 |
| 7 | 技能扫描 | **57 个 gstack 技能**进入目录，0 个缺 `name`，0 个重名 |
| 8 | `bun run typecheck` | 通过 |
| 9 | **补丁可复现性** | 全新浅克隆上游（`dbf400e`）+ `git apply` → 5 个源文件与本机开发版 **SHA256 逐一相同** |
| 10 | **`bun test`** | **20 passed / 0 failed**（38 个断言，不联网、不需要 key） |

**第 3 项最有说服力**：改造后「没有 key 时该拒绝」的行为与上游一字不差——
说明改的是**补通道**，不是拆门禁。

---

## 测试与 CI

```bash
bun test        # 20 个测试，不联网、不需要 key
```

`test/deepseek.test.ts` 是**密封**的：不访问网络，不读本机真实凭据库，
所以它在任何机器上、任何 CI runner 上结果都一样。这一点是**被测行为本身**，
不是顺手写的便利——两个关键回归测试：

- **显式传入的 env 不读盘**。`resolveDeepSeekKey({})` 必须返回 `undefined`，
  哪怕这台机器上 `~/.dsh/.credentials.yaml` 里躺着真 key。守卫一旦被删，
  密封测试就会悄悄读到一把真凭据。
- **`applyDeepSeekEnv` 永不覆盖**。环境里已显式设置的 `ANTHROPIC_BASE_URL`
  必须原样保留——「本来就要连真 Anthropic 的会话」不能被这个改动劫持。

CI（`.github/workflows/ci.yml`）跑两件事：

1. **`test`** —— Ubuntu + Windows 双平台跑 `bun test`。
2. **`patch`** —— 拉取上游固定的 `dbf400ec3f1ffb96a429f0d0b29ca932b3d6c6f0`，
   确认补丁能干净应用，并 **`diff` 五个源文件与 `src/` 是否逐字节相同**。

第 2 项是保证 [src/](src/) 和[补丁](patch/gstack-deepseek-port.patch) 永远
不会各自漂移——你在 GitHub 上读到的代码，就是补丁实际产出的代码。

> 那个基线 commit 在上游没有对应 tag（gstack 不发 release tag），所以只能钉
> 完整的 40 位 SHA。它是**不可变**的：这里变红，只可能是本项目自己改坏了，
> 不会是「上游动了」。

---

## 已知限制

1. **`/gstack-upgrade` 会抹掉改造**
   它内部是 `git fetch && git reset --hard origin/main`。
   升级后重新 `git apply patch/gstack-deepseek-port.patch`。

2. **Claude Code 会打一行黄字**：`[claude-code:unrecognized_model]`。
   它只是不认识 `deepseek-flash` 这个 id，**不影响结果**。

3. **成本报告里的价格是 Anthropic 价**。
   `lib/pricing.ts` 没改，看数字时要知道。

4. **`--exact` token 计数不可用**。DeepSeek 没有 `count_tokens` 接口，
   会自动回落到离线估算。

5. **iOS 系列技能需要真机**。

6. **Aside 浏览器是 macOS 独占**，其他平台走 headless Chromium。

7. **`/connect-chrome` 在 v1.91.95 已改名为 `/open-gstack-browser`**。

---

## 平台说明

| 平台 | 状态 |
|---|---|
| **Windows 10/11** | ✅ 本项目的原始开发环境，全链路实测通过 |
| **Linux** | ✅ 预期可用（改动是平台无关的；`claude-bin.ts` 的 `.cmd` 分支在非 Windows 直接返回原值） |
| **macOS** | ✅ 预期可用，且可额外享受 Aside 浏览器 |

Windows 注意：`./setup` 需要 Git Bash 或 MSYS；Smart App Control 可能拦截
未签名二进制。

---

## 归属与许可

**上游**：[garrytan/gstack](https://github.com/garrytan/gstack) —
MIT，Copyright (c) 2026 Garry Tan。
gstack 这个名字、57 个技能的设计与全部提示词文本都归他。
**如果你觉得这套东西有用，去给上游点 star。**

**本项目**：只做后端适配。`src/lib/claude-bin.ts`、
`src/lib/outside-voice-api.ts`、`src/lib/outside-voice-runner.ts`
是上游文件的修改版（MIT 允许，版权仍归 Garry Tan，已保留声明）；
`src/lib/deepseek.ts`、`src/bin/gstack-deepseek-claude.ts` 为新增。

MIT，见 [LICENSE](LICENSE)。

> 关于文案：[docs/AUTHOR-NOTE.md](docs/AUTHOR-NOTE.md) 那篇「作者的话」
> 是**改写自上游 README** 的，行文和卖点是原作者的，只是把 *Claude Code*
> 换成了 *DeepSeek*。README 里这一节已明确标注来源。
