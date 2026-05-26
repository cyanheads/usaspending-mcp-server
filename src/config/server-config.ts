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
    .default(30_000)
    .describe('HTTP request timeout in milliseconds'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'USASPENDING_BASE_URL',
    timeoutMs: 'USASPENDING_TIMEOUT_MS',
  });
  return _config;
}
