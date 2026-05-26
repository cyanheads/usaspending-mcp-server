/**
 * @fileoverview Tool to fetch a recipient's full profile by recipient ID.
 * @module mcp-server/tools/definitions/get-recipient.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const getRecipientTool = tool('usaspending_get_recipient', {
  title: 'Get Recipient Profile',
  description:
    "Fetch a recipient's full profile including address, business type classifications, parent organization, alternate names, and total award amounts by category. Recipient IDs are UUID hashes with a level suffix (-P parent, -C child, -R standalone) from usaspending_search_recipients or usaspending_get_award. Optionally scope the award totals to a specific fiscal year and award type. UEI and DUNS values can be used to cross-reference with SAM.gov and SEC EDGAR.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    recipient_id: z
      .string()
      .min(1)
      .describe(
        'Recipient hash ID (UUID with level suffix, e.g., b97d19b0-833c-8d8f-3a2c-157d04ea55ef-P) — from usaspending_search_recipients or usaspending_get_award',
      ),
    fiscal_year: z
      .number()
      .int()
      .min(2001)
      .max(2030)
      .optional()
      .describe('Fiscal year to scope award totals (e.g., 2024)'),
    award_type: z
      .enum(['contracts', 'grants', 'direct_payments', 'loans', 'other_financial_assistance'])
      .optional()
      .describe('Award type category to scope award totals'),
  }),

  output: z.object({
    name: z.string().optional().describe('Recipient legal business name'),
    uei: z.string().optional().describe('Unique Entity Identifier (SAM.gov)'),
    duns: z.string().optional().describe('DUNS number (legacy)'),
    recipient_id: z.string().optional().describe('Recipient hash ID'),
    recipient_level: z
      .string()
      .optional()
      .describe('Hierarchy level: P = parent, C = child, R = standalone'),
    parent_name: z.string().optional().describe('Parent organization name'),
    parent_uei: z.string().optional().describe('Parent organization UEI'),
    business_types: z.array(z.string()).optional().describe('Business type codes'),
    business_types_description: z
      .array(z.string())
      .optional()
      .describe('Human-readable business type descriptions'),
    location: z
      .object({
        address_line1: z.string().optional().describe('Street address line 1'),
        address_line2: z.string().optional().describe('Street address line 2'),
        city_name: z.string().optional().describe('City'),
        state_code: z.string().optional().describe('State code'),
        zip5: z.string().optional().describe('5-digit ZIP code'),
        country_code: z.string().optional().describe('Country code'),
      })
      .optional()
      .describe('Recipient address'),
    total: z
      .object({
        contracts: z.number().optional().describe('Total contracts amount in USD'),
        grants: z.number().optional().describe('Total grants amount in USD'),
        direct_payments: z.number().optional().describe('Total direct payments amount in USD'),
        loans: z.number().optional().describe('Total loans amount in USD'),
        other: z.number().optional().describe('Total other financial assistance amount in USD'),
      })
      .optional()
      .describe('Total award amounts by type'),
    alternate_names: z.array(z.string()).optional().describe('Alternate business names'),
  }),

  errors: [
    {
      reason: 'recipient_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No recipient found for the given recipient ID.',
      recovery:
        'Use usaspending_search_recipients to find the correct recipient ID from a name search.',
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
    ctx.log.info('usaspending_get_recipient', { recipient_id: input.recipient_id });
    const svc = getUSASpendingService();
    const r = await svc.getRecipient(
      input.recipient_id,
      {
        ...(input.fiscal_year !== undefined ? { fiscal_year: input.fiscal_year } : {}),
        ...(input.award_type !== undefined ? { award_type: input.award_type } : {}),
      },
      ctx,
    );

    if (!r?.name) {
      throw ctx.fail('recipient_not_found', `Recipient not found: ${input.recipient_id}`, {
        recovery: {
          hint: 'Search for the recipient name with usaspending_search_recipients to find the correct ID.',
        },
      });
    }

    return {
      name: r.name,
      ...(r.uei ? { uei: r.uei } : {}),
      ...(r.duns ? { duns: r.duns } : {}),
      ...(r.recipient_id ? { recipient_id: r.recipient_id } : {}),
      ...(r.recipient_level ? { recipient_level: r.recipient_level } : {}),
      ...(r.parent_name ? { parent_name: r.parent_name } : {}),
      ...(r.parent_uei ? { parent_uei: r.parent_uei } : {}),
      ...(r.business_types?.length ? { business_types: r.business_types } : {}),
      ...(r.business_types_description?.length
        ? { business_types_description: r.business_types_description }
        : {}),
      ...(r.location
        ? {
            location: {
              ...(r.location.address_line1 ? { address_line1: r.location.address_line1 } : {}),
              ...(r.location.address_line2 ? { address_line2: r.location.address_line2 } : {}),
              ...(r.location.city_name ? { city_name: r.location.city_name } : {}),
              ...(r.location.state_code ? { state_code: r.location.state_code } : {}),
              ...(r.location.zip5 ? { zip5: r.location.zip5 } : {}),
              ...(r.location.country_code ? { country_code: r.location.country_code } : {}),
            },
          }
        : {}),
      ...(r.total &&
      (typeof r.total.contracts === 'number' ||
        typeof r.total.grants === 'number' ||
        typeof r.total.direct_payments === 'number' ||
        typeof r.total.loans === 'number' ||
        typeof r.total.other === 'number')
        ? {
            total: {
              ...(typeof r.total.contracts === 'number' ? { contracts: r.total.contracts } : {}),
              ...(typeof r.total.grants === 'number' ? { grants: r.total.grants } : {}),
              ...(typeof r.total.direct_payments === 'number'
                ? { direct_payments: r.total.direct_payments }
                : {}),
              ...(typeof r.total.loans === 'number' ? { loans: r.total.loans } : {}),
              ...(typeof r.total.other === 'number' ? { other: r.total.other } : {}),
            },
          }
        : {}),
      ...(r.alternate_names?.length ? { alternate_names: r.alternate_names } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [`## Recipient: ${result.name ?? 'Unknown'}`];
    if (result.recipient_id) lines.push(`**Recipient ID:** ${result.recipient_id}`);
    if (result.uei) lines.push(`**UEI:** ${result.uei}`);
    if (result.duns) lines.push(`**DUNS:** ${result.duns}`);
    if (result.recipient_level) lines.push(`**Level:** ${result.recipient_level}`);
    if (result.parent_name) lines.push(`**Parent Org:** ${result.parent_name}`);
    if (result.parent_uei) lines.push(`**Parent UEI:** ${result.parent_uei}`);
    if (result.location) {
      const loc = result.location;
      const addr = [
        loc.address_line1,
        loc.address_line2,
        loc.city_name,
        loc.state_code,
        loc.zip5,
        loc.country_code,
      ]
        .filter(Boolean)
        .join(', ');
      if (addr) lines.push(`**Address:** ${addr}`);
    }
    if (result.business_types?.length)
      lines.push(`**Business Type Codes:** ${result.business_types.join(', ')}`);
    if (result.business_types_description?.length)
      lines.push(`**Business Types:** ${result.business_types_description.join(', ')}`);
    if (result.alternate_names?.length) {
      lines.push(`**Alternate Names:** ${result.alternate_names.join(', ')}`);
    }
    if (result.total) {
      lines.push('\n### Award Totals');
      if (typeof result.total.contracts === 'number')
        lines.push(`- **Contracts:** $${result.total.contracts.toLocaleString()}`);
      if (typeof result.total.grants === 'number')
        lines.push(`- **Grants:** $${result.total.grants.toLocaleString()}`);
      if (typeof result.total.direct_payments === 'number')
        lines.push(`- **Direct Payments:** $${result.total.direct_payments.toLocaleString()}`);
      if (typeof result.total.loans === 'number')
        lines.push(`- **Loans:** $${result.total.loans.toLocaleString()}`);
      if (typeof result.total.other === 'number')
        lines.push(`- **Other:** $${result.total.other.toLocaleString()}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
