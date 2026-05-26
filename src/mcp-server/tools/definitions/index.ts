/**
 * @fileoverview Barrel export for all USAspending tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { autocompleteTool } from './autocomplete.tool.js';
export { disasterSpendingTool } from './disaster-spending.tool.js';
export { getAgencyTool } from './get-agency.tool.js';
export { getAwardTool } from './get-award.tool.js';
export { getAwardSubawardsTool } from './get-award-subawards.tool.js';
export { getAwardTransactionsTool } from './get-award-transactions.tool.js';
export { getFederalAccountTool } from './get-federal-account.tool.js';
export { getRecipientTool } from './get-recipient.tool.js';
export { listAgenciesTool } from './list-agencies.tool.js';
export { searchAwardsTool } from './search-awards.tool.js';
export { searchRecipientsTool } from './search-recipients.tool.js';
export { spendingByCategoryTool } from './spending-by-category.tool.js';
export { spendingByGeographyTool } from './spending-by-geography.tool.js';
export { spendingOverTimeTool } from './spending-over-time.tool.js';

import { autocompleteTool } from './autocomplete.tool.js';
import { disasterSpendingTool } from './disaster-spending.tool.js';
import { getAgencyTool } from './get-agency.tool.js';
import { getAwardTool } from './get-award.tool.js';
import { getAwardSubawardsTool } from './get-award-subawards.tool.js';
import { getAwardTransactionsTool } from './get-award-transactions.tool.js';
import { getFederalAccountTool } from './get-federal-account.tool.js';
import { getRecipientTool } from './get-recipient.tool.js';
import { listAgenciesTool } from './list-agencies.tool.js';
import { searchAwardsTool } from './search-awards.tool.js';
import { searchRecipientsTool } from './search-recipients.tool.js';
import { spendingByCategoryTool } from './spending-by-category.tool.js';
import { spendingByGeographyTool } from './spending-by-geography.tool.js';
import { spendingOverTimeTool } from './spending-over-time.tool.js';

export const allToolDefinitions = [
  listAgenciesTool,
  autocompleteTool,
  searchAwardsTool,
  getAwardTool,
  getAwardTransactionsTool,
  getAwardSubawardsTool,
  searchRecipientsTool,
  getRecipientTool,
  getAgencyTool,
  spendingByGeographyTool,
  spendingByCategoryTool,
  spendingOverTimeTool,
  disasterSpendingTool,
  getFederalAccountTool,
] as const;
