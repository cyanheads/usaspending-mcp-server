/**
 * @fileoverview Tool to fetch an agency's overview, budget data, and sub-agency breakdown.
 * @module mcp-server/tools/definitions/get-agency.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { RawSubAgencyEntry } from '@/services/usaspending/types.js';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const getAgencyTool = tool('usaspending_get_agency', {
  title: 'Get Agency Overview',
  description:
    "Fetch an agency's current fiscal year overview including mission, budget authority, obligation totals, sub-agency count, and DEF codes for disaster/emergency funding. Also returns sub-agency breakdown with transaction counts. Accepts either a 3-digit toptier_code (e.g., 097 for DoD, 012 for Agriculture) or an agency_slug (e.g., department-of-defense) — both appear in usaspending_list_agencies results and award search results.",
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
  }),

  output: z.object({
    name: z.string().optional().describe('Agency full name'),
    abbreviation: z.string().optional().describe('Agency abbreviation'),
    toptier_code: z.string().optional().describe('3-digit toptier agency code'),
    agency_id: z.number().optional().describe('Internal agency ID'),
    mission: z.string().optional().describe('Agency mission statement'),
    budget_authority_amount: z
      .number()
      .optional()
      .describe('Total budget authority amount in USD for current fiscal year'),
    obligated_amount: z
      .number()
      .optional()
      .describe('Total obligated amount in USD for current fiscal year'),
    transactions_count: z.number().optional().describe('Total transaction count'),
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
      .describe('Sub-agency breakdown within this toptier agency'),
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
    const [detail, subAgenciesData] = await Promise.all([
      svc.getAgency(toptierCode, ctx),
      svc.getAgencySubAgencies(toptierCode, ctx).catch(() => ({
        results: [] as RawSubAgencyEntry[],
      })),
    ]);

    if (!detail?.name) {
      throw ctx.fail('agency_not_found', `Agency not found: ${toptierCode}`, {
        recovery: {
          hint: 'Call usaspending_list_agencies to browse available agency toptier codes and slugs.',
        },
      });
    }

    const subAgencies = (subAgenciesData.results ?? [])
      .slice(0, 20)
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

    return {
      ...(detail.name ? { name: detail.name } : {}),
      ...(detail.abbreviation ? { abbreviation: detail.abbreviation } : {}),
      toptier_code: toptierCode,
      ...(typeof detail.agency_id === 'number' ? { agency_id: detail.agency_id } : {}),
      ...(detail.mission || detail.agency_overview?.mission
        ? { mission: (detail.mission ?? detail.agency_overview?.mission) || undefined }
        : {}),
      ...(typeof detail.budget_authority_amount === 'number'
        ? { budget_authority_amount: detail.budget_authority_amount }
        : {}),
      ...(typeof detail.obligated_amount === 'number'
        ? { obligated_amount: detail.obligated_amount }
        : {}),
      ...(typeof detail.transactions_count === 'number'
        ? { transactions_count: detail.transactions_count }
        : {}),
      ...(typeof detail.sub_agency_count === 'number'
        ? { subtier_agency_count: detail.sub_agency_count }
        : typeof detail.subtier_agency_count === 'number'
          ? { subtier_agency_count: detail.subtier_agency_count }
          : {}),
      ...(subAgencies.length > 0 ? { sub_agencies: subAgencies } : {}),
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
    if (typeof result.budget_authority_amount === 'number')
      lines.push(`**Budget Authority:** $${result.budget_authority_amount.toLocaleString()}`);
    if (typeof result.obligated_amount === 'number')
      lines.push(`**Obligated:** $${result.obligated_amount.toLocaleString()}`);
    if (typeof result.transactions_count === 'number')
      lines.push(`**Transactions:** ${result.transactions_count.toLocaleString()}`);
    if (typeof result.subtier_agency_count === 'number')
      lines.push(`**Sub-agencies:** ${result.subtier_agency_count}`);
    if (result.website) lines.push(`**Website:** ${result.website}`);

    if (result.sub_agencies?.length) {
      lines.push('\n### Sub-Agency Breakdown');
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
