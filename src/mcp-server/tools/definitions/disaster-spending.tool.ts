/**
 * @fileoverview Tool to fetch disaster and emergency supplemental spending
 * broken down by agency, CFDA program, recipient, or geography.
 * @module mcp-server/tools/definitions/disaster-spending.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { RawDisasterResult, RawPageMetadata } from '@/services/usaspending/types.js';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const disasterSpendingTool = tool('usaspending_disaster_spending', {
  title: 'Disaster and Emergency Spending',
  description:
    'Fetch disaster and emergency supplemental spending (COVID-19, hurricanes, infrastructure law, etc.) broken down by agency, CFDA assistance program, recipient, or geography. Use the dimension parameter to select the breakdown axis: overview (top-level totals), agency, cfda, recipient, or geography. Filter by DEF codes (Disaster/Emergency Funding codes) to isolate a specific emergency appropriation. DEF codes appear in usaspending_get_award account_obligations_by_defc and usaspending_get_agency def_codes fields.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    dimension: z
      .enum(['overview', 'agency', 'cfda', 'recipient', 'geography'])
      .describe(
        'Breakdown axis: overview (top-level totals and DEF code funding), agency (by awarding agency), cfda (by assistance program), recipient (by recipient), geography (by state/county)',
      ),
    spending_type: z
      .enum(['spending', 'loans'])
      .default('spending')
      .describe(
        'Data type: spending (obligations and outlays) or loans (face value of loan guarantees). Applies to agency and recipient dimensions only.',
      ),
    filters: z
      .object({
        def_codes: z
          .array(z.string())
          .optional()
          .describe(
            'DEF codes to filter by (e.g., ["L", "M", "N", "O", "P"] for COVID-19). Omit to include all emergency funding.',
          ),
        award_type_codes: z.array(z.string()).optional().describe('Award type code filters'),
        geo_layer: z
          .enum(['state', 'county'])
          .optional()
          .describe('Geographic layer for geography dimension (state or county)'),
      })
      .optional()
      .describe('Optional filters — def_codes narrows to a specific emergency appropriation'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Maximum results per page (1–100, not used for overview dimension)'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  }),

  output: z.object({
    dimension: z.string().describe('Breakdown dimension returned'),
    spending_type: z.string().describe('Data type returned (spending or loans)'),
    overview: z
      .object({
        total_budget_authority: z
          .number()
          .optional()
          .describe('Total budget authority in USD across all emergency supplementals'),
        award_obligations: z.number().optional().describe('Total award obligations in USD'),
        award_outlays: z.number().optional().describe('Total award outlays in USD'),
        face_value_of_loans: z.number().optional().describe('Face value of loan guarantees in USD'),
        total_obligations: z.number().optional().describe('Total obligations in USD'),
        total_outlays: z.number().optional().describe('Total outlays in USD'),
        unobligated_balance: z.number().optional().describe('Unobligated balance in USD'),
        funding_by_def_code: z
          .array(
            z
              .object({
                def_code: z.string().optional().describe('DEF code'),
                amount: z.number().optional().describe('Funding amount in USD for this DEF code'),
                label: z.string().optional().describe('DEF code label or title'),
                public_law: z.string().optional().describe('Public law number'),
              })
              .describe('DEF code funding entry with amount and public law reference'),
          )
          .optional()
          .describe('Funding amounts broken down by DEF code (emergency appropriation)'),
      })
      .optional()
      .describe('Top-level overview totals (dimension=overview only)'),
    results: z
      .array(
        z
          .object({
            id: z.string().optional().describe('Item ID'),
            code: z.string().optional().describe('Code (agency code, CFDA number, DEF code, etc.)'),
            name: z.string().optional().describe('Item name or description'),
            obligation: z.number().optional().describe('Obligation amount in USD'),
            outlay: z.number().optional().describe('Outlay amount in USD'),
            award_count: z.number().optional().describe('Number of awards'),
            face_value_of_loan: z
              .number()
              .optional()
              .describe('Face value of loan guarantees in USD (loans spending_type)'),
            shape_code: z.string().optional().describe('Geographic code (geography dimension)'),
            display_name: z
              .string()
              .optional()
              .describe('Geographic display name (geography dimension)'),
            aggregated_amount: z
              .number()
              .optional()
              .describe('Aggregated amount in USD (geography dimension)'),
          })
          .describe(
            'Disaster spending breakdown entry by dimension (agency, CFDA, recipient, or geography)',
          ),
      )
      .describe('Breakdown results (empty for overview dimension)'),
    page_metadata: z
      .object({
        has_next: z.boolean().describe('Whether there are more pages'),
        page: z.number().describe('Current page'),
        total: z.number().optional().describe('Total items'),
        limit: z.number().describe('Items per page'),
      })
      .optional()
      .describe('Pagination metadata (non-overview dimensions)'),
  }),

  errors: [
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No disaster spending data found for the specified filters.',
      recovery:
        'Remove DEF code filters to include all emergency funds, or try a different dimension.',
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
    ctx.log.info('usaspending_disaster_spending', {
      dimension: input.dimension,
      spending_type: input.spending_type,
    });
    const svc = getUSASpendingService();

    const baseBody: Record<string, unknown> = {};
    const filterBody: Record<string, unknown> = {};
    if (input.filters?.def_codes?.length) filterBody.def_codes = input.filters.def_codes;
    if (input.filters?.award_type_codes?.length)
      filterBody.award_type_codes = input.filters.award_type_codes;
    if (Object.keys(filterBody).length > 0) baseBody.filter = filterBody;

    if (input.dimension === 'overview') {
      const data = await svc.getDisasterOverview(ctx);
      const funding = (data.funding ?? []).map((f) => ({
        ...(f.def_code ? { def_code: f.def_code } : {}),
        ...(typeof f.amount === 'number' ? { amount: f.amount } : {}),
        ...(f.label ? { label: f.label } : {}),
        ...(f.public_law ? { public_law: f.public_law } : {}),
      }));
      const spending = data.spending ?? {};
      return {
        dimension: 'overview',
        spending_type: 'spending',
        overview: {
          ...(typeof data.total_budget_authority === 'number'
            ? { total_budget_authority: data.total_budget_authority }
            : {}),
          ...(typeof spending.award_obligations === 'number'
            ? { award_obligations: spending.award_obligations }
            : {}),
          ...(typeof spending.award_outlays === 'number'
            ? { award_outlays: spending.award_outlays }
            : {}),
          ...(typeof spending.face_value_of_loans === 'number'
            ? { face_value_of_loans: spending.face_value_of_loans }
            : {}),
          ...(typeof spending.total_obligations === 'number'
            ? { total_obligations: spending.total_obligations }
            : {}),
          ...(typeof spending.total_outlays === 'number'
            ? { total_outlays: spending.total_outlays }
            : {}),
          ...(typeof spending.unobligated_balance === 'number'
            ? { unobligated_balance: spending.unobligated_balance }
            : {}),
          ...(funding.length > 0 ? { funding_by_def_code: funding } : {}),
        },
        results: [],
      };
    }

    const paginationBody = { ...baseBody, limit: input.limit, page: input.page };

    let rawResults: { results: RawDisasterResult[]; page_metadata: RawPageMetadata };

    if (input.dimension === 'agency') {
      const data = await svc.getDisasterByAgency(input.spending_type, paginationBody, ctx);
      rawResults = { results: data.results ?? [], page_metadata: data.page_metadata ?? {} };
    } else if (input.dimension === 'cfda') {
      const data = await svc.getDisasterByCfda(paginationBody, ctx);
      rawResults = { results: data.results ?? [], page_metadata: data.page_metadata ?? {} };
    } else if (input.dimension === 'recipient') {
      const data = await svc.getDisasterByRecipient(input.spending_type, paginationBody, ctx);
      rawResults = { results: data.results ?? [], page_metadata: data.page_metadata ?? {} };
    } else {
      // geography
      const geoBody = {
        ...baseBody,
        geo_layer: input.filters?.geo_layer ?? 'state',
        scope: 'place_of_performance',
      };
      const data = await svc.getDisasterByGeography(geoBody, ctx);
      const geoResults = (data.results ?? []).map((r) => ({
        shape_code: r.shape_code ?? undefined,
        display_name: r.display_name ?? undefined,
        aggregated_amount:
          typeof r.aggregated_amount === 'number' ? r.aggregated_amount : undefined,
        population: typeof r.population === 'number' ? r.population : undefined,
        per_capita: typeof r.per_capita === 'number' ? r.per_capita : undefined,
      }));
      return {
        dimension: 'geography',
        spending_type: input.spending_type,
        results: geoResults,
        page_metadata: {
          has_next: false,
          page: 1,
          total: geoResults.length,
          limit: input.limit,
        },
      };
    }

    const results = (rawResults.results ?? []).map((r) => ({
      ...(r.id != null ? { id: String(r.id) } : {}),
      ...(r.code ? { code: r.code } : {}),
      ...(r.name || r.description ? { name: r.name ?? r.description ?? undefined } : {}),
      ...(typeof r.obligation === 'number' ? { obligation: r.obligation } : {}),
      ...(typeof r.outlay === 'number' ? { outlay: r.outlay } : {}),
      ...(typeof r.award_count === 'number' ? { award_count: r.award_count } : {}),
      ...(typeof r.face_value_of_loan === 'number'
        ? { face_value_of_loan: r.face_value_of_loan }
        : {}),
    }));

    const pageMeta = rawResults.page_metadata ?? {};
    return {
      dimension: input.dimension,
      spending_type: input.spending_type,
      results,
      page_metadata: {
        has_next: pageMeta.hasNext ?? false,
        page: pageMeta.page ?? input.page,
        ...(typeof pageMeta.total === 'number' ? { total: pageMeta.total } : {}),
        limit: input.limit,
      },
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Disaster/Emergency Spending — ${result.dimension}${result.spending_type !== 'spending' ? ` (${result.spending_type})` : ''}`,
    ];

    if (result.overview) {
      const o = result.overview;
      if (o.total_budget_authority !== undefined)
        lines.push(`**Total Budget Authority:** $${o.total_budget_authority.toLocaleString()}`);
      if (o.total_obligations !== undefined)
        lines.push(`**Total Obligations:** $${o.total_obligations.toLocaleString()}`);
      if (o.total_outlays !== undefined)
        lines.push(`**Total Outlays:** $${o.total_outlays.toLocaleString()}`);
      if (o.award_obligations !== undefined)
        lines.push(`**Award Obligations:** $${o.award_obligations.toLocaleString()}`);
      if (o.award_outlays !== undefined)
        lines.push(`**Award Outlays:** $${o.award_outlays.toLocaleString()}`);
      if (o.face_value_of_loans !== undefined)
        lines.push(`**Face Value of Loans:** $${o.face_value_of_loans.toLocaleString()}`);
      if (o.unobligated_balance !== undefined)
        lines.push(`**Unobligated Balance:** $${o.unobligated_balance.toLocaleString()}`);

      if (o.funding_by_def_code?.length) {
        lines.push('\n### Funding by DEF Code');
        for (const f of o.funding_by_def_code) {
          const amt = f.amount !== undefined ? `$${f.amount.toLocaleString()}` : 'N/A';
          lines.push(
            `- **${f.def_code ?? 'N/A'}** — ${f.label ?? 'N/A'} (${f.public_law ?? 'N/A'}): ${amt}`,
          );
        }
      }
    }

    if (result.page_metadata) {
      const pm = result.page_metadata;
      lines.push(
        `**Page:** ${pm.page}${pm.total !== undefined ? ` of ~${pm.total}` : ''} | **Per page:** ${pm.limit} | **Has next:** ${pm.has_next ? 'Yes' : 'No'}`,
      );
    }

    if (result.results.length === 0) {
      if (!result.overview) {
        lines.push(
          '\n> No data found. Try removing DEF code filters or selecting a different dimension.',
        );
      }
    } else {
      lines.push('');
      lines.push(
        '| Name/Display | ID | Code | Shape | Obligation | Outlay | Aggregated | Loans | Awards |',
      );
      lines.push(
        '|:-------------|:---|:-----|:------|:-----------|:-------|:-----------|:------|:-------|',
      );
      for (const r of result.results) {
        const label =
          r.display_name && r.name && r.display_name !== r.name
            ? `${r.display_name} (${r.name})`
            : (r.display_name ?? r.name ?? 'N/A');
        const id = r.id ?? 'N/A';
        const code = r.code ?? 'N/A';
        const shape = r.shape_code ?? 'N/A';
        const oblig = r.obligation !== undefined ? `$${r.obligation.toLocaleString()}` : 'N/A';
        const outlay = r.outlay !== undefined ? `$${r.outlay.toLocaleString()}` : 'N/A';
        const agg =
          r.aggregated_amount !== undefined ? `$${r.aggregated_amount.toLocaleString()}` : 'N/A';
        const loans =
          r.face_value_of_loan !== undefined ? `$${r.face_value_of_loan.toLocaleString()}` : 'N/A';
        const awards = r.award_count !== undefined ? String(r.award_count) : 'N/A';
        lines.push(
          `| ${label} | ${id} | ${code} | ${shape} | ${oblig} | ${outlay} | ${agg} | ${loans} | ${awards} |`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
