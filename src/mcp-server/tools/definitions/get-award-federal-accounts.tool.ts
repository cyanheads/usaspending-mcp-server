/**
 * @fileoverview Tool to list the Treasury federal accounts that funded an award.
 * @module mcp-server/tools/definitions/get-award-federal-accounts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { formatPaginationLine } from './pagination.js';

export const getAwardFederalAccountsTool = tool('usaspending_get_award_federal_accounts', {
  title: 'Get Award Federal Accounts',
  description:
    'List the Treasury federal accounts that funded an award, with the amount obligated from each and the funding agency behind it. This is the award → appropriation link: each row returns federal_account (AGENCY-MAIN format, e.g. 080-0120) to chain into usaspending_get_federal_account for the account budget detail. The award_id must be a generated_unique_award_id — from usaspending_search_awards (generated_internal_id field) or usaspending_get_award. Distinct from usaspending_get_award account_obligations_by_defc, which breaks funding down by Disaster/Emergency Funding code rather than by account. An award_id that does not exist returns an empty list rather than an error.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    award_id: z
      .string()
      .min(1)
      .describe(
        'Award generated_unique_award_id (e.g., CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-) — use generated_internal_id from usaspending_search_awards or generated_unique_award_id from usaspending_get_award',
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
    award_id: z.string().describe('Award ID queried'),
    results: z
      .array(
        z
          .object({
            federal_account: z
              .string()
              .optional()
              .describe(
                'Federal account code in AGENCY-MAIN format (e.g., 080-0120) — pass to usaspending_get_federal_account as account_code for the account budget detail',
              ),
            account_title: z.string().optional().describe('Full federal account title'),
            total_transaction_obligated_amount: z
              .number()
              .optional()
              .describe('Amount obligated to this award from this federal account in USD'),
            funding_agency_name: z.string().optional().describe('Name of the funding agency'),
            funding_agency_abbreviation: z
              .string()
              .optional()
              .describe('Abbreviation of the funding agency (e.g., "NASA")'),
            funding_agency_slug: z
              .string()
              .optional()
              .describe(
                'Funding agency slug (e.g., "national-aeronautics-and-space-administration") — pass to usaspending_get_agency as agency_slug',
              ),
            funding_agency_id: z
              .number()
              .optional()
              .describe(
                'Internal USAspending database ID of the funding agency — not the toptier code accepted by usaspending_get_agency',
              ),
            funding_toptier_agency_id: z
              .number()
              .optional()
              .describe(
                'Internal USAspending database ID of the funding toptier agency — not the 3-digit toptier code accepted by usaspending_get_agency',
              ),
          })
          .describe('Federal account that funded this award, with obligation and funding agency'),
      )
      .describe('Federal accounts funding this award'),
    page_metadata: z
      .object({
        count: z.number().optional().describe('Total funding accounts across all pages'),
        page: z.number().describe('Current page number'),
        has_next: z.boolean().describe('Whether there are more pages of results'),
        has_previous: z.boolean().describe('Whether there are previous pages'),
        limit: z.number().describe('Results per page'),
      })
      .describe('Pagination metadata'),
  }),

  // Agent-facing context: the true total across pages, pagination state, and an
  // empty-result notice. The upstream answers a nonexistent award_id with HTTP 200
  // and zero rows — indistinguishable from a real award with no account linkage —
  // so the empty case is a notice, not a declared failure.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Total number of funding accounts across all pages (when available)'),
    current_page: z.number().describe('Current page returned'),
    has_next_page: z.boolean().describe('Whether there are more pages of funding accounts'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — the award_id may not exist or may have no account linkage. Absent when results are present.',
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
    ctx.log.info('usaspending_get_award_federal_accounts', {
      award_id: input.award_id,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const data = await svc.getAwardFederalAccounts(
      { award_id: input.award_id, limit: input.limit, page: input.page },
      ctx,
    );

    const results = (data.results ?? []).map((r) => ({
      ...(r.federal_account ? { federal_account: r.federal_account } : {}),
      ...(r.account_title ? { account_title: r.account_title } : {}),
      ...(typeof r.total_transaction_obligated_amount === 'number'
        ? { total_transaction_obligated_amount: r.total_transaction_obligated_amount }
        : {}),
      ...(r.funding_agency_name ? { funding_agency_name: r.funding_agency_name } : {}),
      ...(r.funding_agency_abbreviation
        ? { funding_agency_abbreviation: r.funding_agency_abbreviation }
        : {}),
      ...(r.funding_agency_slug ? { funding_agency_slug: r.funding_agency_slug } : {}),
      ...(typeof r.funding_agency_id === 'number'
        ? { funding_agency_id: r.funding_agency_id }
        : {}),
      ...(typeof r.funding_toptier_agency_id === 'number'
        ? { funding_toptier_agency_id: r.funding_toptier_agency_id }
        : {}),
    }));

    const pageMeta = data.page_metadata ?? {};
    const total = typeof pageMeta.count === 'number' ? pageMeta.count : undefined;
    const currentPage = typeof pageMeta.page === 'number' ? pageMeta.page : input.page;
    const hasNext = pageMeta.hasNext ?? false;
    const hasPrevious = pageMeta.hasPrevious ?? false;

    if (total !== undefined) ctx.enrich.total(total);
    ctx.enrich({
      current_page: currentPage,
      has_next_page: hasNext,
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        `No federal accounts fund award "${input.award_id}". ` +
          'Verify the award_id is a generated_unique_award_id from usaspending_search_awards ' +
          '(generated_internal_id field) — a nonexistent award_id returns this same empty result.',
      );
    }

    return {
      award_id: input.award_id,
      results,
      page_metadata: {
        ...(total !== undefined ? { count: total } : {}),
        page: currentPage,
        has_next: hasNext,
        has_previous: hasPrevious,
        limit: input.limit,
      },
    };
  },

  format: (result) => {
    const lines: string[] = [`## Federal Accounts Funding Award: ${result.award_id}`];
    const paginationLine = formatPaginationLine({
      page: result.page_metadata.page,
      limit: result.page_metadata.limit,
      has_next: result.page_metadata.has_next,
      total: result.page_metadata.count,
    });
    lines.push(
      `**Results:** ${result.results.length} | ${paginationLine} | **Has previous:** ${result.page_metadata.has_previous ? 'Yes' : 'No'}`,
    );
    for (const a of result.results) {
      lines.push('');
      lines.push(`### ${a.account_title ?? a.federal_account ?? 'Unknown'}`);
      if (a.federal_account)
        lines.push(`**Account Code (for get_federal_account):** ${a.federal_account}`);
      if (typeof a.total_transaction_obligated_amount === 'number')
        lines.push(
          `**Obligated from this account:** $${a.total_transaction_obligated_amount.toLocaleString()}`,
        );
      if (a.funding_agency_name)
        lines.push(
          `**Funding Agency:** ${a.funding_agency_name}${a.funding_agency_abbreviation ? ` (${a.funding_agency_abbreviation})` : ''}`,
        );
      if (a.funding_agency_slug) lines.push(`**Funding Agency Slug:** ${a.funding_agency_slug}`);
      if (typeof a.funding_agency_id === 'number')
        lines.push(`**Funding Agency ID:** ${a.funding_agency_id}`);
      if (typeof a.funding_toptier_agency_id === 'number')
        lines.push(`**Funding Toptier Agency ID:** ${a.funding_toptier_agency_id}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
