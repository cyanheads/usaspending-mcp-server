/**
 * @fileoverview Server-specific environment variable configuration for usaspending-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .default('https://api.usaspending.gov/api/v2/')
    .describe('USAspending.gov API v2 base URL'),
  timeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .default(45_000)
    .describe(
      'Per-attempt HTTP timeout in milliseconds. Each attempt is cut at this or at the time left in the request budget, whichever is smaller, and an attempt that times out is not retried.',
    ),
  retryBudgetMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .optional()
    .describe(
      'Wall-clock budget in milliseconds for one request, every attempt and retry backoff included. Fast transient failures (5xx, network errors) retry inside it. Defaults to 45000, or to the per-attempt timeout when that is higher, so one attempt can always run its full timeout.',
    ),
  /**
   * Optional rather than defaulted: the service reads none of it, and `ServerConfig`
   * values built for the service alone stay complete. `clampLimitsEnabled()` applies
   * the default.
   */
  clampLimits: z
    .stringbool()
    .optional()
    .describe(
      'Reduces a result-count input above its per-call cap to the cap, disclosed on the result, instead of rejecting it. Default true. False advertises each cap as the schema maximum and rejects a larger value.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * The server config, parsed from the environment once. `setup()` reaches it first,
 * so an invalid value stops startup with the banner naming the variable. Never call
 * it at module import: `tool()` emits input schemas when a definition module loads.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'USASPENDING_BASE_URL',
    timeoutMs: 'USASPENDING_TIMEOUT_MS',
    retryBudgetMs: 'USASPENDING_RETRY_BUDGET_MS',
    clampLimits: 'USASPENDING_CLAMP_LIMITS',
  });
  return _config;
}

/**
 * Whether count inputs clamp (`USASPENDING_CLAMP_LIMITS`, default true). Reads the
 * config `getServerConfig()` parsed, or the default before `setup()` runs, and never
 * parses the environment itself: input schemas call it on every parse and every
 * `tools/list` emission, the first of them at import.
 */
export function clampLimitsEnabled(): boolean {
  return _config?.clampLimits ?? true;
}
