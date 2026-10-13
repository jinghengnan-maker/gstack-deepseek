# 技能清单

gstack 贡献 **57 个技能**。调用方式全部是斜杠命令（`/browse`、`/review`…），
技能定义在各自的 `SKILL.md` 里——**你可以打开读，也可以改**。

> 数字经实际扫描核对：`~/.dsh/skills` 下 61 个 DSH 可见条目 =
> 57 个 gstack + 4 个既有技能；0 个缺 `name`，0 个重名。

---

## 规划与评审

| 技能 | 干什么 |
|---|---|
| `/office-hours` | YC Office Hours 式对谈，把你的模糊想法逼成一个能说清楚的方案 |
| `/plan-ceo-review` | CEO / 创始人视角：**这东西到底该不该做** |
| `/plan-eng-review` | 工程经理视角：**这么写会不会塌** |
| `/plan-design-review` | 设计师视角的计划评审，交互式 |
| `/plan-devex-review` | 开发者体验视角的计划评审 |
| `/plan-tune` | 调整提问的敏感度与开发者画像（v1 为观察模式） |
| `/autoplan` | **自动串一遍**：依次读 CEO / 设计 / 工程 / DX 四个评审技能并自动决策 |
| `/spec` | 五阶段把模糊意图变成可执行的规格说明 |
| `/design-consultation` | 设计咨询：理解产品、调研同类、提出完整设计系统 |
| `/devex-review` | 实时的开发者体验审计 |

## 实现与代码审查

| 技能 | 干什么 |
|---|---|
| `/review` | 上线前的 PR 评审，找生产环境级别的 bug |
| `/deslop-shared-libs` | 在近期改动里找出**值得抽成公共库**的部分 |
| `/test-audit` | 找出低价值 / 重复的测试，以及只为它们而活的代码 |
| `/codex` | 把活派给 OpenAI Codex CLI（三种模式） |
| `/investigate` | 系统化调试：先查根因，再动手 |
| `/health` | 代码质量仪表盘 |

## 设计与界面

| 技能 | 干什么 |
|---|---|
| `/design-review` | 设计师之眼 QA：视觉不一致、间距、层级、AI 味、卡顿交互——**找到并修掉** |
| `/design-shotgun` | 一次生成多个设计变体，开对比板收集结构化反馈并迭代 |
| `/design-html` | 产出可上线的 HTML / CSS |

## 浏览器与抓取

| 技能 | 干什么 |
|---|---|
| `/browse` | **驱动真实浏览器**：打开页面、读内容、点击流程、截图、看控制台 |
| `/qa` | 修浏览器 / API / CLI / 任务 / worker / webhook 的 bug |
| `/qa-only` | 同上，但**只报告不改** |
| `/scrape` | 从网页抓数据 |
| `/skillify` | 把最近一次成功的抓取流程固化成可复用的 browser-skill |
| `/open-gstack-browser` | 启动可见的 GStack Browser（AI 控制的 Chromium，内置侧边栏） |
| `/setup-browser-cookies` | 从你真实的 Chromium 导入 cookie 到无头会话 |
| `/pair-agent` | 把远程 AI Agent 与你的浏览器配对 |

> **本项目的硬规矩**：所有网页浏览走 `/browse`，
> **切勿使用 `mcp__claude-in-chrome__*` 工具**。
> 这条写在全局指令文件里，不是建议。

## 发布与部署

| 技能 | 干什么 |
|---|---|
| `/ship` | 合并基线 → 跑测试 → 审查 diff → 改 VERSION → 更新 CHANGELOG → 提交 → 推送 → 开 PR |
| `/land-and-deploy` | 落地并部署 |
| `/canary` | 部署后金丝雀监控 |
| `/landing-report` | 只读的队列看板（配合 `/ship`） |
| `/setup-deploy` | 配置 `/land-and-deploy` 的部署参数 |
| `/document-release` | 发版文档审计 |
| `/document-generate` | 从零生成缺失的文档 |

## 记忆与度量

| 技能 | 干什么 |
|---|---|
| `/context-save` | 保存当前工作上下文 |
| `/context-restore` | 恢复之前保存的上下文 |
| `/learn` | 管理项目经验 |
| `/retro` | 每周工程复盘 |
| `/benchmark` | 网页性能回归检测 |
| `/benchmark-models` | 跨模型跑 gstack 技能的基准 ⚠️ **花钱** |
| `/eval-plan` | 预注册付费评测：跑 dry-run，再用三项计价试点决定是否放行 ⚠️ **花钱** |
| `/setup-gbrain` | 装 gbrain（本地 PGLite 或 Supabase）并注册 MCP |
| `/sync-gbrain` | 让 gbrain 跟上仓库变化 |

## 安全与边界

| 技能 | 干什么 |
|---|---|
| `/cso` | 安全审计：静态发现 + 复现 + 修复候选 |
| `/careful` | 危险命令警告 |
| `/guard` | **全安全模式**：危险命令警告 + 目录级编辑限制 |
| `/freeze` | 把编辑限制在某个目录内 |
| `/unfreeze` | 解除 `/freeze` 的限制 |

## iOS（需要真机）

| 技能 | 干什么 |
|---|---|
| `/ios-qa` | 真机上的 iOS QA |
| `/ios-fix` | 自主修 iOS bug |
| `/ios-design-review` | 真机视觉设计审计 |
| `/ios-clean` | 摘掉 DebugBridge 与所有 `#if DEBUG` 接线 |
| `/ios-sync` | 按最新上游模板重新生成 iOS 调试桥 |

## 工具与路由

| 技能 | 干什么 |
|---|---|
| `/make-pdf` | 把任意 markdown 变成出版级 PDF |
| `/diagram` | 把一段描述（或 mermaid）变成图：源码 + 可编辑的 `.excalidraw` + SVG/PNG |
| `/gstack` | **路由器**——整个技能套件的索引 |
| `/gstack-upgrade` | 升级 gstack ⚠️ **会抹掉本项目补丁**，见下 |

---

## 两个必须知道的坑

### `/gstack-upgrade` 会删掉本项目

它内部是：

```bash
git fetch origin && git reset --hard origin/main
```

升级完重新打一遍补丁：

```bash
git apply /path/to/gstack-deepseek/patch/gstack-deepseek-port.patch
```

### `/connect-chrome` 已经不存在了

老版本叫 `/connect-chrome`，**v1.91.95 起改名为 `/open-gstack-browser`**。
如果你看到的教程里写着 `/connect-chrome`，那是旧文档。
