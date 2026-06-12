/**
 * @fileoverview Tool to list and keyword-search federal accounts by agency or title keyword.
 * @module mcp-server/tools/definitions/search-federal-accounts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const searchFederalAccountsTool = tool('usaspending_search_federal_accounts', {
  title: 'Search Federal Accounts',
  description:
    'List and keyword-search federal accounts by agency identifier or title keyword. Returns account numbers, names, managing agencies, and budgetary resources. Use account_number from results as input to usaspending_get_federal_account for full budget detail. Use usaspending_list_agencies to look up agency_identifier codes (3-digit strings, e.g. "097" for DoD).',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    keyword: z
      .string()
      .optional()
      .describe('Filter accounts by name or title keyword (e.g., "defense", "transportation")'),
    agency_identifier: z
      .string()
      .optional()
      .describe(
        '3-digit agency identifier code (e.g., "097" for Department of Defense). Use usaspending_list_agencies to look up codes.',
      ),
    sort_field: z
      .enum(['account_name', 'account_number', 'budgetary_resources', 'managing_agency'])
      .default('budgetary_resources')
      .describe('Field to sort results by'),
    sort_direction: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Maximum results per page (1–100)'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            account_number: z
              .string()
              .optional()
              .describe(
                'Federal account code (e.g., "097-8097") — pass to usaspending_get_federal_account for full detail',
              ),
            account_name: z.string().optional().describe('Full federal account title'),
            agency_identifier: z
              .string()
              .optional()
              .describe('3-digit agency identifier code for this account'),
            managing_agency: z.string().optional().describe('Name of the managing agency'),
            managing_agency_acronym: z
              .string()
              .optional()
              .describe('Acronym of the managing agency (e.g., "DOD")'),
            budgetary_resources: z
              .number()
              .optional()
              .describe('Total budgetary resources for this account in USD'),
          })
          .describe('Federal account record with code, name, agency, and budget'),
      )
      .describe('Matching federal accounts'),
    page_metadata: z
      .object({
        count: z.number().optional().describe('Total matching accounts across all pages'),
        page: z.number().describe('Current page number'),
        has_next: z.boolean().describe('Whether there are more pages of results'),
        limit: z.number().describe('Results per page'),
      })
      .describe('Pagination metadata'),
  }),

  // Agent-facing context: total match count, current page, and an optional
  // recovery notice for empty results.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Total number of matching accounts across all pages (when available)'),
    page: z.number().describe('Current page number returned'),
    has_next: z.boolean().describe('Whether there are more pages of results'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — echoes applied filters and suggests how to broaden. Absent when results are present.',
      ),
  },

  errors: [
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USAspending.gov API is unreachable or returns an error.',
      retryable: true,
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_search_federal_accounts', {
      keyword: input.keyword,
      agency_identifier: input.agency_identifier,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const body: Record<string, unknown> = {
      sort: { field: input.sort_field, direction: input.sort_direction },
      page: input.page,
      limit: input.limit,
    };
    if (input.keyword) body.keyword = input.keyword;
    if (input.agency_identifier) {
      body.filters = { agency_identifier: input.agency_identifier };
    }

    const data = await svc.searchFederalAccounts(body, ctx);

    const results = ((data.results as unknown[]) ?? []).map((r) => {
      const raw = r as Record<string, unknown>;
      return {
        ...(raw.account_number ? { account_number: String(raw.account_number) } : {}),
        ...(raw.account_name ? { account_name: String(raw.account_name) } : {}),
        ...(raw.agency_identifier ? { agency_identifier: String(raw.agency_identifier) } : {}),
        ...(raw.managing_agency ? { managing_agency: String(raw.managing_agency) } : {}),
        ...(raw.managing_agency_acronym
          ? { managing_agency_acronym: String(raw.managing_agency_acronym) }
          : {}),
        ...(typeof raw.budgetary_resources === 'number'
          ? { budgetary_resources: raw.budgetary_resources }
          : {}),
      };
    });

    const total = typeof data.count === 'number' ? data.count : undefined;
    const currentPage = typeof data.page === 'number' ? data.page : input.page;
    const hasNext = data.hasNext ?? false;

    if (total !== undefined) ctx.enrich.total(total);
    ctx.enrich({
      page: currentPage,
      has_next: hasNext,
    });

    if (results.length === 0) {
      const filterParts: string[] = [];
      if (input.keyword) filterParts.push(`keyword="${input.keyword}"`);
      if (input.agency_identifier)
        filterParts.push(`agency_identifier="${input.agency_identifier}"`);
      const notice =
        filterParts.length > 0
          ? `No federal accounts matched: ${filterParts.join(', ')}. Try removing filters or using a broader keyword.`
          : 'No federal accounts matched. Try a different keyword or agency identifier.';
      ctx.enrich.notice(notice);
    }

    return {
      results,
      page_metadata: {
        ...(total !== undefined ? { count: total } : {}),
        page: currentPage,
        has_next: hasNext,
        limit: input.limit,
      },
    };
  },

  format: (result) => {
    const lines: string[] = ['## Federal Account Search Results'];
    lines.push(
      `\n**Results:** ${result.results.length} | **Page:** ${result.page_metadata.page}${result.page_metadata.count !== undefined ? ` of ~${result.page_metadata.count}` : ''} | **Per page:** ${result.page_metadata.limit} | **Has next:** ${result.page_metadata.has_next ? 'Yes' : 'No'}`,
    );
    for (const a of result.results) {
      lines.push('');
      lines.push(`### ${a.account_name ?? a.account_number ?? 'Unknown'}`);
      if (a.account_number) lines.push(`**Account Number:** ${a.account_number}`);
      if (a.agency_identifier) lines.push(`**Agency ID:** ${a.agency_identifier}`);
      if (a.managing_agency)
        lines.push(
          `**Managing Agency:** ${a.managing_agency}${a.managing_agency_acronym ? ` (${a.managing_agency_acronym})` : ''}`,
        );
      if (typeof a.budgetary_resources === 'number')
        lines.push(`**Budgetary Resources:** $${a.budgetary_resources.toLocaleString()}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
