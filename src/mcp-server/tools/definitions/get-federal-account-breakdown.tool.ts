/**
 * @fileoverview Tool to fetch a federal account's obligations broken down by
 * program activity or object class.
 * @module mcp-server/tools/definitions/get-federal-account-breakdown.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { formatPaginationLine } from './pagination.js';

export const getFederalAccountBreakdownTool = tool('usaspending_get_federal_account_breakdown', {
  title: 'Get Federal Account Breakdown',
  description:
    "Fetch a federal account's obligations broken down by program activity (what the money funds) or object class (what it buys — personnel, supplies, contracts). Use the dimension parameter to select the axis. Account codes are AGENCY-MAIN format and come from usaspending_search_federal_accounts (its account_number output field), usaspending_get_award_federal_accounts (its federal_account field), or usaspending_get_federal_account. Paginated with an honest total count. For the account's own metadata and top-level totals, use usaspending_get_federal_account.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    account_code: z
      .string()
      .min(1)
      .describe(
        'Federal account code in AGENCY-MAIN format (e.g., 097-0100). Returned as account_number by usaspending_search_federal_accounts and as federal_account by usaspending_get_award_federal_accounts.',
      ),
    dimension: z
      .enum(['program_activity', 'object_class'])
      .describe(
        'Breakdown axis: program_activity (obligations by the program the funds support) or object_class (obligations by the category of goods/services purchased)',
      ),
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
    account_code: z.string().describe('Federal account code queried'),
    dimension: z.string().describe('Breakdown dimension returned'),
    results: z
      .array(
        z
          .object({
            code: z
              .string()
              .optional()
              .describe('Program activity code or object class code (e.g., "0001", "25.2")'),
            name: z.string().optional().describe('Program activity name or object class name'),
            obligations: z.number().optional().describe('Obligated amount in USD'),
            type: z
              .string()
              .optional()
              .describe(
                'Program activity code system, returned only for the program_activity dimension: "PAC/PAN" (legacy program activity code/name) or "PARK" (Program Activity Reporting Key). Both can appear for the same account. Absent for object_class rows.',
              ),
          })
          .describe('Breakdown row with code, name, and obligated amount'),
      )
      .describe('Breakdown rows for the requested dimension'),
    page_metadata: z
      .object({
        total: z.number().optional().describe('Total rows across all pages'),
        page: z.number().describe('Current page number'),
        has_next: z.boolean().describe('Whether there are more pages of results'),
        has_previous: z.boolean().describe('Whether there are previous pages'),
        limit: z.number().describe('Results per page'),
      })
      .describe('Pagination metadata'),
  }),

  // Agent-facing context: the true total across pages, pagination state, and an
  // empty-result notice. Both breakdown endpoints answer a nonexistent account
  // code with HTTP 200 and total: 0 — indistinguishable from a real account with
  // no obligations on this axis — so the empty case is a notice, not a declared
  // failure. (usaspending_get_federal_account's GET route does 400 on a miss and
  // can therefore keep a not-found contract; these POST routes cannot.)
  enrichment: {
    applied_dimension: z.string().describe('Breakdown dimension applied'),
    totalCount: z
      .number()
      .optional()
      .describe('Total number of breakdown rows across all pages (when available)'),
    current_page: z.number().describe('Current page returned'),
    has_next_page: z.boolean().describe('Whether there are more pages of breakdown rows'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — the account code may not exist or may have no obligations on this axis. Absent when results are present.',
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
    ctx.log.info('usaspending_get_federal_account_breakdown', {
      account_code: input.account_code,
      dimension: input.dimension,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const body = { limit: input.limit, page: input.page };
    const data =
      input.dimension === 'program_activity'
        ? await svc.getFederalAccountProgramActivities(input.account_code, body, ctx)
        : await svc.getFederalAccountObjectClasses(input.account_code, body, ctx);

    const results = (data.results ?? []).map((r) => ({
      ...(r.code ? { code: r.code } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(typeof r.obligations === 'number' ? { obligations: r.obligations } : {}),
      ...(r.type ? { type: r.type } : {}),
    }));

    const pageMeta = data.page_metadata ?? {};
    const total = typeof pageMeta.total === 'number' ? pageMeta.total : undefined;
    const currentPage = typeof pageMeta.page === 'number' ? pageMeta.page : input.page;
    const hasNext = pageMeta.hasNext ?? false;
    const hasPrevious = pageMeta.hasPrevious ?? false;

    if (total !== undefined) ctx.enrich.total(total);
    ctx.enrich({
      applied_dimension: input.dimension,
      current_page: currentPage,
      has_next_page: hasNext,
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        `No ${input.dimension} obligations found for federal account "${input.account_code}". ` +
          'Verify the code with usaspending_search_federal_accounts and pass its account_number value ' +
          '— a nonexistent account code returns this same empty result. ' +
          `Try dimension="${input.dimension === 'program_activity' ? 'object_class' : 'program_activity'}" for the other breakdown axis.`,
      );
    }

    return {
      account_code: input.account_code,
      dimension: input.dimension,
      results,
      page_metadata: {
        ...(total !== undefined ? { total } : {}),
        page: currentPage,
        has_next: hasNext,
        has_previous: hasPrevious,
        limit: input.limit,
      },
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Federal Account ${result.account_code} — ${result.dimension} breakdown`,
    ];
    const paginationLine = formatPaginationLine({
      page: result.page_metadata.page,
      limit: result.page_metadata.limit,
      has_next: result.page_metadata.has_next,
      total: result.page_metadata.total,
    });
    lines.push(
      `**Results:** ${result.results.length} | ${paginationLine} | **Has previous:** ${result.page_metadata.has_previous ? 'Yes' : 'No'}`,
    );

    if (result.results.length > 0) {
      // `type` is a program-activity concept — object-class rows never carry one, so the
      // column appears only when a row has a value for it. An always-empty column reads
      // as missing data rather than an inapplicable concept.
      const hasType = result.results.some((r) => r.type);
      lines.push('');
      lines.push(
        hasType ? '| Code | Name | Obligations | Type |' : '| Code | Name | Obligations |',
      );
      lines.push(
        hasType ? '|:-----|:-----|:------------|:-----|' : '|:-----|:-----|:------------|',
      );
      for (const r of result.results) {
        const obligations =
          typeof r.obligations === 'number' ? `$${r.obligations.toLocaleString()}` : 'N/A';
        const row = `| ${r.code ?? 'N/A'} | ${r.name ?? 'N/A'} | ${obligations} |`;
        lines.push(hasType ? `${row} ${r.type ?? 'N/A'} |` : row);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
