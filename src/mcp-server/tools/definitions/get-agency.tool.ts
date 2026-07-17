/**
 * @fileoverview Tool to fetch an agency's overview, budget data, and sub-agency breakdown.
 * @module mcp-server/tools/definitions/get-agency.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { RawBudgetaryResources, RawSubAgencyEntry } from '@/services/usaspending/types.js';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { formatPaginationLine } from './pagination.js';

/** Sub-agency breakdown page size (the endpoint's natural page cap). */
const SUB_AGENCY_PAGE_LIMIT = 10;

export const getAgencyTool = tool('usaspending_get_agency', {
  title: 'Get Agency Overview',
  description:
    "Fetch an agency's fiscal-year overview including mission, budgetary resources, obligation and outlay totals (for the most recent fiscal year), sub-agency count, and DEF codes for disaster/emergency funding. Also returns a paginated sub-agency breakdown with obligation and transaction counts. Accepts either a 3-digit toptier_code (e.g., 097 for DoD, 012 for Agriculture) or an agency_slug (e.g., department-of-defense) — both appear in usaspending_list_agencies results and award search results.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    toptier_code: z
      .string()
      .optional()
      .describe(
        '3-digit toptier agency code (e.g., 097, 012) — from usaspending_list_agencies. Use either toptier_code or agency_slug, not both.',
      ),
    agency_slug: z
      .string()
      .optional()
      .describe(
        'URL-friendly agency slug (e.g., department-of-defense) — from usaspending_list_agencies or award search results. Use either toptier_code or agency_slug, not both.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Sub-agency breakdown page (1-based, 10 per page). Use with sub_agency_page_metadata.has_next to page through the full list.',
      ),
  }),

  output: z.object({
    name: z.string().optional().describe('Agency full name'),
    abbreviation: z.string().optional().describe('Agency abbreviation'),
    toptier_code: z.string().optional().describe('3-digit toptier agency code'),
    agency_id: z.number().optional().describe('Internal agency ID'),
    mission: z.string().optional().describe('Agency mission statement'),
    fiscal_year: z
      .number()
      .optional()
      .describe('Fiscal year the budgetary totals below reflect (most recent available)'),
    budgetary_resources_amount: z
      .number()
      .optional()
      .describe('Total budgetary resources in USD for the fiscal year'),
    obligated_amount: z
      .number()
      .optional()
      .describe('Total amount obligated in USD for the fiscal year'),
    outlay_amount: z.number().optional().describe('Total outlays in USD for the fiscal year'),
    subtier_agency_count: z
      .number()
      .optional()
      .describe('Number of sub-agencies within this toptier agency'),
    sub_agencies: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Sub-agency name'),
            abbreviation: z.string().optional().describe('Sub-agency abbreviation'),
            total_obligations: z.number().optional().describe('Sub-agency obligation total in USD'),
            transaction_count: z.number().optional().describe('Sub-agency transaction count'),
            new_award_count: z.number().optional().describe('New awards count'),
          })
          .describe('Sub-agency entry with obligations and transaction counts'),
      )
      .optional()
      .describe('Sub-agency breakdown within this toptier agency (one page)'),
    sub_agency_page_metadata: z
      .object({
        total: z.number().optional().describe('Total sub-agencies across all pages'),
        page: z.number().describe('Current sub-agency page number'),
        has_next: z.boolean().describe('Whether more sub-agency pages are available'),
        limit: z.number().describe('Sub-agencies per page'),
      })
      .optional()
      .describe('Pagination metadata for the sub-agency breakdown'),
    def_codes: z
      .array(
        z
          .object({
            code: z.string().optional().describe('DEF code identifying an emergency supplemental'),
            public_law: z.string().optional().describe('Public law number'),
            title: z.string().optional().describe('Emergency or disaster title'),
          })
          .describe('DEF code entry with public law and title'),
      )
      .optional()
      .describe('Disaster/Emergency Funding (DEF) codes applicable to this agency'),
    website: z.string().optional().describe('Agency website URL'),
  }),

  // Agent-facing context: sub-agency pagination state and truncation guidance.
  enrichment: {
    sub_agency_page: z.number().describe('Current sub-agency page returned'),
    has_more_sub_agencies: z.boolean().describe('Whether more sub-agency pages are available'),
    sub_agency_total: z
      .number()
      .optional()
      .describe('Total sub-agencies across all pages (when available)'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the sub-agency breakdown is truncated — how to page for the rest. Absent when the last page is shown.',
      ),
  },

  errors: [
    {
      reason: 'agency_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No agency found for the given toptier_code or agency_slug.',
      recovery:
        'Use usaspending_list_agencies to browse available agencies and find the correct code or slug.',
    },
    {
      reason: 'missing_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither toptier_code nor agency_slug was provided.',
      recovery:
        'Provide either a toptier_code (e.g., 097) or agency_slug (e.g., department-of-defense).',
    },
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USAspending.gov API is unreachable or returns an error.',
      retryable: true,
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
    },
  ],

  async handler(input, ctx) {
    if (!input.toptier_code?.trim() && !input.agency_slug?.trim()) {
      throw ctx.fail('missing_input', 'Either toptier_code or agency_slug is required', {
        recovery: {
          hint: 'Call usaspending_list_agencies to find the correct toptier_code or agency_slug.',
        },
      });
    }

    const svc = getUSASpendingService();
    let toptierCode = input.toptier_code?.trim();

    // Resolve slug → toptier_code if needed
    if (!toptierCode && input.agency_slug?.trim()) {
      const slug = input.agency_slug.trim().toLowerCase();
      ctx.log.info('usaspending_get_agency resolving slug', { slug });
      const agencies = await svc.listAgencies({}, ctx);
      const match = (agencies.results ?? []).find(
        (a) =>
          a.agency_slug?.toLowerCase() === slug ||
          a.agency_name?.toLowerCase().replace(/\s+/g, '-') === slug,
      );
      if (!match?.toptier_code) {
        throw ctx.fail('agency_not_found', `No agency found with slug: ${input.agency_slug}`, {
          recovery: {
            hint: 'Call usaspending_list_agencies to browse available agency slugs and toptier codes.',
          },
        });
      }
      toptierCode = match.toptier_code;
    }

    ctx.log.info('usaspending_get_agency', { toptier_code: toptierCode });
    if (!toptierCode) {
      throw ctx.fail('missing_input', 'Either toptier_code or agency_slug is required', {
        recovery: {
          hint: 'Call usaspending_list_agencies to find the correct toptier_code or agency_slug.',
        },
      });
    }
    const [detail, subAgenciesData, budgetData] = await Promise.all([
      svc.getAgency(toptierCode, ctx),
      svc
        .getAgencySubAgencies(toptierCode, { page: input.page, limit: SUB_AGENCY_PAGE_LIMIT }, ctx)
        .catch(() => ({ results: [] as RawSubAgencyEntry[], page_metadata: undefined })),
      svc
        .getAgencyBudgetaryResources(toptierCode, ctx)
        .catch(() => ({ agency_data_by_year: [] as RawBudgetaryResources[] })),
    ]);

    if (!detail?.name) {
      throw ctx.fail('agency_not_found', `Agency not found: ${toptierCode}`, {
        recovery: {
          hint: 'Call usaspending_list_agencies to browse available agency toptier codes and slugs.',
        },
      });
    }

    // Budget totals live on the budgetary-resources endpoint, not the agency overview.
    // Pick the most recent fiscal year available.
    const currentBudget = [...(budgetData.agency_data_by_year ?? [])].sort(
      (a, b) => (b.fiscal_year ?? 0) - (a.fiscal_year ?? 0),
    )[0];

    const subAgencies = (subAgenciesData.results ?? [])
      .map((s) => ({
        ...(s.name ? { name: s.name } : {}),
        ...(s.abbreviation ? { abbreviation: s.abbreviation } : {}),
        ...(typeof s.total_obligations === 'number'
          ? { total_obligations: s.total_obligations }
          : {}),
        ...(typeof s.transaction_count === 'number'
          ? { transaction_count: s.transaction_count }
          : {}),
        ...(typeof s.new_award_count === 'number' ? { new_award_count: s.new_award_count } : {}),
      }))
      .filter((s) => s.name);

    const subMeta = subAgenciesData.page_metadata ?? {};
    const subPage = subMeta.page ?? input.page;
    const subHasNext = subMeta.hasNext ?? false;
    const subTotal = typeof subMeta.total === 'number' ? subMeta.total : undefined;

    ctx.enrich({
      sub_agency_page: subPage,
      has_more_sub_agencies: subHasNext,
      ...(subTotal !== undefined ? { sub_agency_total: subTotal } : {}),
    });
    if (subHasNext) {
      ctx.enrich.notice(
        `Showing sub-agency page ${subPage}${subTotal !== undefined ? ` of ${subTotal} total` : ''}. Call again with page=${subPage + 1} for more sub-agencies.`,
      );
    }

    return {
      ...(detail.name ? { name: detail.name } : {}),
      ...(detail.abbreviation ? { abbreviation: detail.abbreviation } : {}),
      toptier_code: toptierCode,
      ...(typeof detail.agency_id === 'number' ? { agency_id: detail.agency_id } : {}),
      ...(detail.mission || detail.agency_overview?.mission
        ? { mission: (detail.mission ?? detail.agency_overview?.mission) || undefined }
        : {}),
      ...(typeof currentBudget?.fiscal_year === 'number'
        ? { fiscal_year: currentBudget.fiscal_year }
        : {}),
      ...(typeof currentBudget?.agency_budgetary_resources === 'number'
        ? { budgetary_resources_amount: currentBudget.agency_budgetary_resources }
        : {}),
      ...(typeof currentBudget?.agency_total_obligated === 'number'
        ? { obligated_amount: currentBudget.agency_total_obligated }
        : {}),
      ...(typeof currentBudget?.agency_total_outlayed === 'number'
        ? { outlay_amount: currentBudget.agency_total_outlayed }
        : {}),
      ...(typeof detail.sub_agency_count === 'number'
        ? { subtier_agency_count: detail.sub_agency_count }
        : typeof detail.subtier_agency_count === 'number'
          ? { subtier_agency_count: detail.subtier_agency_count }
          : {}),
      ...(subAgencies.length > 0 ? { sub_agencies: subAgencies } : {}),
      ...(subAgencies.length > 0
        ? {
            sub_agency_page_metadata: {
              ...(subTotal !== undefined ? { total: subTotal } : {}),
              page: subPage,
              has_next: subHasNext,
              limit: subMeta.limit ?? SUB_AGENCY_PAGE_LIMIT,
            },
          }
        : {}),
      ...(detail.def_codes?.length
        ? {
            def_codes: detail.def_codes.map((d) => ({
              ...(d.code ? { code: d.code } : {}),
              ...(d.public_law ? { public_law: d.public_law } : {}),
              ...(d.title ? { title: d.title } : {}),
            })),
          }
        : {}),
      ...(detail.website ? { website: detail.website } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Agency: ${result.name ?? 'Unknown'}${result.abbreviation ? ` (${result.abbreviation})` : ''}`,
    ];
    if (result.toptier_code) lines.push(`**Toptier Code:** ${result.toptier_code}`);
    if (typeof result.agency_id === 'number') lines.push(`**Agency ID:** ${result.agency_id}`);
    if (result.mission) lines.push(`**Mission:** ${result.mission}`);
    if (typeof result.fiscal_year === 'number')
      lines.push(`**Fiscal Year:** ${result.fiscal_year}`);
    if (typeof result.budgetary_resources_amount === 'number')
      lines.push(`**Budgetary Resources:** $${result.budgetary_resources_amount.toLocaleString()}`);
    if (typeof result.obligated_amount === 'number')
      lines.push(`**Obligated:** $${result.obligated_amount.toLocaleString()}`);
    if (typeof result.outlay_amount === 'number')
      lines.push(`**Outlays:** $${result.outlay_amount.toLocaleString()}`);
    if (typeof result.subtier_agency_count === 'number')
      lines.push(`**Sub-agencies:** ${result.subtier_agency_count}`);
    if (result.website) lines.push(`**Website:** ${result.website}`);

    if (result.sub_agencies?.length || result.sub_agency_page_metadata) {
      lines.push('\n### Sub-Agency Breakdown');
      if (result.sub_agency_page_metadata)
        lines.push(formatPaginationLine(result.sub_agency_page_metadata));
    }
    if (result.sub_agencies?.length) {
      lines.push('| Sub-Agency | Obligations | Transactions | New Awards |');
      lines.push('|:-----------|:------------|:-------------|:-----------|');
      for (const s of result.sub_agencies) {
        const oblig =
          typeof s.total_obligations === 'number'
            ? `$${s.total_obligations.toLocaleString()}`
            : 'N/A';
        const txns =
          typeof s.transaction_count === 'number' ? s.transaction_count.toLocaleString() : 'N/A';
        const newAwards =
          typeof s.new_award_count === 'number' ? s.new_award_count.toLocaleString() : 'N/A';
        lines.push(
          `| ${s.name ?? 'N/A'}${s.abbreviation ? ` (${s.abbreviation})` : ''} | ${oblig} | ${txns} | ${newAwards} |`,
        );
      }
    }

    if (result.def_codes?.length) {
      lines.push('\n### Disaster/Emergency Funding Codes');
      for (const d of result.def_codes) {
        lines.push(
          `- **${d.code ?? 'N/A'}** — ${d.title ?? 'N/A'}${d.public_law ? ` (${d.public_law})` : ''}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
