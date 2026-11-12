/**
 * @fileoverview Test helpers for USASPENDING_CLAMP_LIMITS (#99): load modules with the
 * switch set and the config parsed the way `setup()` parses it, and read one input
 * property as `tools/list` advertises it.
 * @module tests/helpers/clamp-mode
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { vi } from 'vitest';

/**
 * Re-imports fresh modules with USASPENDING_CLAMP_LIMITS set to `value` and the server
 * config parsed, as `createApp()` runs `setup()` after the tool modules load. Import
 * the definition under test inside `load`. Pair with `vi.unstubAllEnvs()` in `afterEach`.
 */
export async function loadWithClampLimits<T>(
  value: 'true' | 'false',
  load: () => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.stubEnv('USASPENDING_CLAMP_LIMITS', value);
  const { getServerConfig } = await import('@/config/server-config.js');
  getServerConfig();
  return load();
}

/** One input property as `tools/list` advertises it: the SDK reads the schema through `~standard`. */
export function advertisedProperty(input: z.ZodObject, key: string): unknown {
  const { properties } = input['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
  return (properties as Record<string, unknown>)[key];
}
