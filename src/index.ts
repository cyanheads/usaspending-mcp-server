#!/usr/bin/env node
/**
 * @fileoverview usaspending-mcp-server MCP server entry point.
 * Provides access to USAspending.gov federal award, recipient, agency, and spending data.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initUSASpendingService } from './services/usaspending/usaspending-service.js';

await createApp({
  tools: [...allToolDefinitions],
  resources: [],
  prompts: [],
  landing: { requireAuth: false },
  instructions:
    'USAspending.gov MCP server — federal award, recipient, agency, and spending data from the US Treasury DATA Act platform.\n' +
    '- Start with usaspending_list_agencies or usaspending_autocomplete to discover agency codes and NAICS/PSC codes\n' +
    '- Use usaspending_search_awards to find awards, then usaspending_get_award for full details\n' +
    '- Chain recipient_id from usaspending_get_award into usaspending_get_recipient for entity profiles\n' +
    '- Search window: 2007-10-01 onward. DoD contracts have a 90-day publication lag.',
  setup(core) {
    const serverConfig = getServerConfig();
    initUSASpendingService(core.config, core.storage, serverConfig);
  },
});
