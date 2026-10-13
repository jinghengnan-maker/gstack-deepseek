# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号跟随上游 gstack；本项目的补丁版本用 `-ds.N` 表示第 N 次适配修订。

## [Unreleased]

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
