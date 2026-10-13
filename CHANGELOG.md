# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号跟随上游 gstack；本项目的补丁版本用 `-ds.N` 表示第 N 次适配修订。

## [Unreleased]

### Added

- README 新增「装了之后什么能用」：57 个技能按「直接能用 / 需要额外条件」
  分开列清，并说明「外脑」评审的同族拒绝是有意行为。
- CI 新增 `installers` job：在干净 runner 上真跑一遍 `install.sh`
  （克隆 → 打补丁 → 注册），并守住两条不可回退的约定——
  补丁必须仍能应用到上游 HEAD，`install.ps1` 必须是纯 ASCII。

### Fixed

- `install.ps1` —— **Windows 上装不下去的硬阻塞**：脚本原来只查 PATH 里有没有
  `bash`，而 Git for Windows 只把 `<root>\cmd` 放进 PATH，`<root>\bin` 从来不进。
  上游 `./setup` 是 bash 脚本，所以每个正常安装 Git 的 Windows 用户都会在
  第一步失败。现在新增 `Resolve-GitBash`：先查 PATH，再从 `git.exe` 反推安装根
  （同时兼容 `<root>\cmd\git.exe` 与 `<root>\bin\git.exe` 两种布局），
  再依次查常见安装位置与注册表 `HKLM:\SOFTWARE\GitForWindows`。
  同时把 bun 所在目录前置进 PATH，保证 bash 子进程也能找到 bun。
- `install.ps1` / `install.sh` —— 路径锚点 `~/.claude/skills/gstack` 改为**总是创建**，
  不再只在 `--register claude` 时创建。原因是 `lib/claude-bin.ts` 的
  `resolveDeepSeekShim()` 正是从这个路径找内置 shim：不建锚点，
  没装 Claude Code 的机器就完全找不到 Agent。
- `install.sh` —— bun 的官方安装器把二进制放进 `~/.bun/bin`，非交互式 shell
  不会 source 它。现在会先探测 `~/.bun/bin` 与 `/usr/local/bin` 再加入 PATH。
- `install.ps1` / `install.sh` —— 收尾横幅改为明确打印**用的是哪个 Agent**；
  shim 没建出来时直接打印可以照抄的构建命令，而不是让人以为已经能跑。

### Changed

- `docs/AUTHOR-NOTE.md` —— 补齐改写。新增「工序（The sprint）」「该跑哪个
  review」「平行的冲刺」「卸载 / 回滚」「关于遥测」五节，并把「See it work」
  从一行摘要换成上游那段完整对话示例（`Claude:` → `DeepSeek:`）。
  工序、专家分工表、并行冲刺的叙事全部照原作者的写法保留，
  只把后端从 Claude Code 换成 DeepSeek；凡属本项目立场的段落都有明确标注。
- README「安装脚本说明」按实测结论改写：`install.ps1` 已在全新目标目录上
  端到端跑通并列出验证项；`install.sh` 仍**只做过语法检查**，如实标注。

## [1.91.95-ds.1] — 2026-10

首次发布。基于上游 gstack v1.91.95。

### Added

- `lib/deepseek.ts` —— DeepSeek 凭据、端点与模型解析。
  按 `DEEPSEEK_API_KEY` → `GSTACK_DEEPSEEK_API_KEY` → 凭据库的顺序查找；
  凭据库支持 `$DSH_HOME/.credentials.yaml`、`~/.dsh/.credentials.yaml`、
  `~/.gstack/credentials.yaml`。`applyDeepSeekEnv()` 幂等，且**只填空值，
  从不覆盖调用方已设的变量**。
- `lib/outside-voice-api.ts` —— 新增 `deepseek` 家族与传输通道。
  缺少自家 key 的 `anthropic` / `openai` 家族由 DeepSeek 接管，
  结果中携带真实的 `provider` 与 `model`，**不做伪装**。
- `bin/gstack-deepseek-claude.ts` —— 独立 Agent：直接对 DeepSeek API
  实现 `claude -p --output-format json` 协议，内置 `Read` / `Grep` / `Glob`
  工具循环、工作目录围栏与调用上限。用于**没装 Claude Code** 的机器。
- `test/deepseek.test.ts` —— 20 个测试，**密封**：不联网、不需要 key、
  不读本机真实凭据库。其中两个是回归守卫：显式传入的 env 对象不得读盘，
  以及 `applyDeepSeekEnv()` 不得覆盖调用方已设的值。
- `.github/workflows/ci.yml` —— 两个 job：双平台跑 `bun test`；拉取上游固定
  commit，确认补丁干净应用，并 `diff` 五个源文件与 `src/` 逐字节一致，
  防止 `src/` 与补丁各自漂移。

### Fixed

- `lib/claude-bin.ts` —— Windows 上 `Bun.which('claude')` 会命中 npm 的
  `.cmd` 包装，而 `child_process.spawn` 在 `shell: false` 下拒绝执行
  batch file（`EINVAL`，CVE-2024-27980 之后的加固）。
  现在解析到其背后的真实 `.exe`；解析不到时回落到内置 DeepSeek shim。
  **真实的 `claude` 永远优先，此回落只在原本会返回 `null` 的位置生效。**
- `lib/outside-voice-runner.ts` —— `ApiRunner.available()` 原先把
  `deepseek` 家族当作「没有 API 适配器」直接拒绝，导致请求还没发出就被拦。
  补一行可用性判断。上游的 `FAMILY_RULES` 本来就认识 `deepseek` 家族
  （`lib/outside-voice-runner.ts:64`），本项目只是不再在门口拦它。

### Known issues

- `/gstack-upgrade` 会执行 `git reset --hard origin/main`，抹掉本补丁。
- 成本报告仍使用 `lib/pricing.ts` 中的 Anthropic 价格。
- `--exact` token 计数在 DeepSeek 上不可用（无对应接口），回落离线估算。
