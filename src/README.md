# `src/` — the six-file port

These are the **complete, post-patch** versions of every file the port touches.
`patch/gstack-deepseek-port.patch` produces exactly these bytes from upstream
`dbf400ec3f1ffb96a429f0d0b29ca932b3d6c6f0`; CI enforces that with `diff`.

They are here to be **read**, not to be built in place — they import gstack
modules that live in the upstream tree. To actually run them, apply the patch to
a gstack checkout (that is what `install.sh` / `install.ps1` do).

## The files

| File | Kind | Why it changed |
| --- | --- | --- |
| `lib/deepseek.ts` | **new** | Credential, endpoint and model resolution. Reads `DEEPSEEK_API_KEY` from the environment, falls back to `$DSH_HOME/.credentials.yaml`, and owns `applyDeepSeekEnv()`. |
| `bin/gstack-deepseek-claude.ts` | **new** | A `claude -p` protocol shim backed by DeepSeek's Anthropic-compatible endpoint, so gstack's agent paths work with no Claude Code installed at all. |
| `lib/claude-bin.ts` | patched | Adds spawnable-executable resolution (npm's `claude.cmd` cannot be spawned without a shell) and a third fallback to the shim. |
| `lib/outside-voice-api.ts` | patched | Adds the `deepseek` family to `API_FAMILIES`, `apiKeyFor` and transport planning. |
| `lib/outside-voice-runner.ts` | patched | `ApiRunner.available()` admits the DeepSeek family instead of refusing with `no API adapter for model family deepseek`. |

Plus one line of `.gitignore` for the compiled shim.

## Where to start reading

- **The whole design in one file:** `lib/deepseek.ts` (135 lines). The two
  comments worth reading are on `resolveDeepSeekKey` (why an explicitly passed
  env object must not touch the disk) and `applyDeepSeekEnv` (why
  `GSTACK_CLAUDE_MODEL` matters more than it looks).
- **What a "port" actually costs:** `lib/outside-voice-runner.ts` changes by
  five lines. Everything else was already environment-driven.
- **The non-obvious part:** `lib/claude-bin.ts`. The interesting bug was not
  about models at all — it was that `spawn()` refuses `.cmd` files.

## Verified API surface

`lib/deepseek.ts` exports, exercised by `test/deepseek.test.ts`:

```ts
DEEPSEEK_ANTHROPIC_BASE   'https://api.deepseek.com/anthropic'
DEEPSEEK_OPENAI_BASE      'https://api.deepseek.com/v1'
DEEPSEEK_MODEL            'deepseek-flash'
DEEPSEEK_REASONING_MODEL  'deepseek-reasoner'

readDeepSeekKeyFromStore(env?): string | undefined
resolveDeepSeekKey(env?): string | undefined
deepSeekAvailable(env?): boolean
deepSeekEnv(env?): DeepSeekEnv | undefined
applyDeepSeekEnv(env?): boolean
```

## Two invariants worth not breaking

1. **`applyDeepSeekEnv` never overwrites.** Every assignment is guarded, so an
   explicit `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` in the environment always
   wins. A session that means to talk to real Anthropic still can.
2. **A caller-supplied `env` object is a closed world.** `resolveDeepSeekKey`
   returns early when `env !== process.env` rather than consulting the store.
   `os.homedir()` reads the real profile regardless of what the caller passed,
   so without this guard a hermetic test run would pick up a live key off disk.

Both have dedicated tests. Both are easy to delete by accident while
"simplifying".
