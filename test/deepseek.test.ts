/**
 * Tests for the DeepSeek port's credential, endpoint and env layer.
 *
 * Hermetic by construction: no network, no key required, and no dependency on
 * the machine's real credential store. That last property is not a convenience
 * — it is the behaviour under test. `resolveDeepSeekKey` deliberately refuses
 * to touch `~/.dsh/.credentials.yaml` when the caller hands it an env object,
 * because gstack's `test/helpers/hermetic-env.ts` relies on an explicitly
 * passed env being a closed world. A regression there would silently leak a
 * live key into hermetic runs, so the guard gets its own test below.
 *
 * Run: bun test
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEEPSEEK_ANTHROPIC_BASE,
  DEEPSEEK_MODEL,
  DEEPSEEK_OPENAI_BASE,
  DEEPSEEK_REASONING_MODEL,
  applyDeepSeekEnv,
  deepSeekAvailable,
  deepSeekEnv,
  readDeepSeekKeyFromStore,
  resolveDeepSeekKey,
} from '../src/lib/deepseek';

/** A throwaway credential store, so tests never read the real one. */
function tmpStore(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-ds-test-'));
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), contents, 'utf8');
  return dir;
}

describe('constants', () => {
  test('endpoints are DeepSeek, not Anthropic', () => {
    expect(DEEPSEEK_ANTHROPIC_BASE).toBe('https://api.deepseek.com/anthropic');
    expect(DEEPSEEK_OPENAI_BASE).toBe('https://api.deepseek.com/v1');
    expect(DEEPSEEK_ANTHROPIC_BASE).not.toContain('anthropic.com');
  });

  test('default model ids are ones DeepSeek actually serves', () => {
    expect(DEEPSEEK_MODEL).toMatch(/^deepseek/);
    expect(DEEPSEEK_REASONING_MODEL).toMatch(/^deepseek/);
  });
});

describe('resolveDeepSeekKey', () => {
  test('reads DEEPSEEK_API_KEY', () => {
    expect(resolveDeepSeekKey({ DEEPSEEK_API_KEY: 'sk-a' })).toBe('sk-a');
  });

  test('falls back to the GSTACK_-prefixed form', () => {
    expect(resolveDeepSeekKey({ GSTACK_DEEPSEEK_API_KEY: 'sk-b' })).toBe('sk-b');
  });

  test('the unprefixed name wins', () => {
    expect(
      resolveDeepSeekKey({ DEEPSEEK_API_KEY: 'sk-plain', GSTACK_DEEPSEEK_API_KEY: 'sk-prefixed' }),
    ).toBe('sk-plain');
  });

  test('trims, and treats whitespace-only as unset', () => {
    expect(resolveDeepSeekKey({ DEEPSEEK_API_KEY: '  sk-c  ' })).toBe('sk-c');
    expect(resolveDeepSeekKey({ DEEPSEEK_API_KEY: '   ' })).toBeUndefined();
  });

  test('an explicit env object is a closed world — it never reads the disk store', () => {
    // On a machine with a populated ~/.dsh/.credentials.yaml this assertion is
    // load-bearing: it fails the moment the hermetic guard is removed.
    expect(resolveDeepSeekKey({})).toBeUndefined();
    expect(deepSeekAvailable({})).toBe(false);
  });
});

describe('readDeepSeekKeyFromStore', () => {
  test('parses a plain key', () => {
    expect(readDeepSeekKeyFromStore({ DSH_HOME: tmpStore('DEEPSEEK_API_KEY: sk-store\n') })).toBe(
      'sk-store',
    );
  });

  test('parses a quoted key', () => {
    expect(
      readDeepSeekKeyFromStore({ DSH_HOME: tmpStore('DEEPSEEK_API_KEY: "sk-quoted"\n') }),
    ).toBe('sk-quoted');
  });

  test('ignores a commented-out line and takes the real one', () => {
    const store = tmpStore('# DEEPSEEK_API_KEY: sk-decoy\nDEEPSEEK_API_KEY: sk-real\n');
    expect(readDeepSeekKeyFromStore({ DSH_HOME: store })).toBe('sk-real');
  });

  test('finds the key among unrelated entries', () => {
    const store = tmpStore(
      ['FENNO_API_KEY: other', 'records:', '  - secret: nope', 'DEEPSEEK_API_KEY: sk-mixed'].join(
        '\n',
      ),
    );
    expect(readDeepSeekKeyFromStore({ DSH_HOME: store })).toBe('sk-mixed');
  });

  test('DSH_HOME takes precedence over the default profile path', () => {
    // The value returned is the temp one, proving precedence by construction.
    expect(readDeepSeekKeyFromStore({ DSH_HOME: tmpStore('DEEPSEEK_API_KEY: sk-first\n') })).toBe(
      'sk-first',
    );
  });
});

describe('deepSeekEnv', () => {
  test('undefined without a key', () => {
    expect(deepSeekEnv({})).toBeUndefined();
  });

  test('returns the documented defaults', () => {
    expect(deepSeekEnv({ DEEPSEEK_API_KEY: 'sk-x' })).toEqual({
      apiKey: 'sk-x',
      anthropicBase: DEEPSEEK_ANTHROPIC_BASE,
      openaiBase: DEEPSEEK_OPENAI_BASE,
      model: DEEPSEEK_MODEL,
      reasoningModel: DEEPSEEK_REASONING_MODEL,
    });
  });

  test('honours every GSTACK_DEEPSEEK_* override', () => {
    const cfg = deepSeekEnv({
      DEEPSEEK_API_KEY: 'sk-x',
      GSTACK_DEEPSEEK_ANTHROPIC_BASE: 'https://gateway.internal/anthropic',
      GSTACK_DEEPSEEK_OPENAI_BASE: 'https://gateway.internal/v1',
      GSTACK_DEEPSEEK_MODEL: 'deepseek-chat',
      GSTACK_DEEPSEEK_REASONING_MODEL: 'deepseek-reasoner-pro',
    });
    expect(cfg).toEqual({
      apiKey: 'sk-x',
      anthropicBase: 'https://gateway.internal/anthropic',
      openaiBase: 'https://gateway.internal/v1',
      model: 'deepseek-chat',
      reasoningModel: 'deepseek-reasoner-pro',
    });
  });
});

describe('applyDeepSeekEnv', () => {
  test('reports false and changes nothing when there is no key', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    expect(applyDeepSeekEnv(env)).toBe(false);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  test('fills the seven variables gstack reads', () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'sk-x' };
    expect(applyDeepSeekEnv(env)).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-x');
    expect(env.ANTHROPIC_BASE_URL).toBe(DEEPSEEK_ANTHROPIC_BASE);
    expect(env.ANTHROPIC_MODEL).toBe(DEEPSEEK_MODEL);
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe(DEEPSEEK_MODEL);
    // model-policy.ts refuses to pick a model for a non-default base URL until
    // one is named; this is the value that satisfies that gate.
    expect(env.GSTACK_CLAUDE_MODEL).toBe(DEEPSEEK_MODEL);
    expect(env.GSTACK_EVAL_MODEL_DISTILL).toBe(DEEPSEEK_MODEL);
  });

  test('never overwrites a value the caller already set', () => {
    // The promise in the module doc: a session that means to talk to real
    // Anthropic still can.
    const env: NodeJS.ProcessEnv = {
      DEEPSEEK_API_KEY: 'sk-x',
      ANTHROPIC_API_KEY: 'sk-ant-real',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      GSTACK_CLAUDE_MODEL: 'claude-opus-4-7',
    };
    applyDeepSeekEnv(env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-real');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6');
    expect(env.GSTACK_CLAUDE_MODEL).toBe('claude-opus-4-7');
    // Untouched ones are still filled — the guard is per-variable, not all-or-nothing.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-x');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe(DEEPSEEK_MODEL);
  });

  test('is idempotent', () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'sk-x' };
    applyDeepSeekEnv(env);
    const once = { ...env };
    applyDeepSeekEnv(env);
    expect(env).toEqual(once);
  });

  test('a blank existing value counts as unset', () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: '   ' };
    applyDeepSeekEnv(env);
    expect(env.ANTHROPIC_BASE_URL).toBe(DEEPSEEK_ANTHROPIC_BASE);
  });
});
