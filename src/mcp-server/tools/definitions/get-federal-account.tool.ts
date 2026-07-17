/**
 * @fileoverview Tool to fetch a federal account's budget data, obligations, and outlays.
 * @module mcp-server/tools/definitions/get-federal-account.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const getFederalAccountTool = tool('usaspending_get_federal_account', {
  title: 'Get Federal Account',
  description:
    "Fetch a federal account's budget data: total obligations, gross outlays, and budgetary resources, plus the per-Treasury-Account-Symbol (TAS) component breakdown in children. Federal accounts connect appropriations law to actual agency spending. Account codes come from usaspending_search_federal_accounts (its account_number output field) or usaspending_get_award_federal_accounts (its federal_account field), and are formatted as AGENCY-MAIN (e.g., 097-0100 for DoD Operation and Maintenance). For obligations broken down by program activity or object class, use usaspending_get_federal_account_breakdown.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    account_code: z
      .string()
      .min(1)
      .describe(
        'Federal account code in AGENCY-MAIN format (e.g., 097-0100). Returned as account_number by usaspending_search_federal_accounts and as federal_account by usaspending_get_award_federal_accounts.',
      ),
  }),

  output: z.object({
    account_title: z.string().optional().describe('Full account title'),
    federal_account_code: z.string().optional().describe('Federal account code'),
    agency_identifier: z.string().optional().describe('Agency identifier code'),
    main_account_code: z.string().optional().describe('Main account code'),
    parent_agency_name: z.string().optional().describe('Managing parent agency name'),
    bureau_name: z.string().optional().describe('Bureau name within the agency'),
    total_obligated_amount: z.number().optional().describe('Total obligated amount in USD'),
    total_gross_outlay_amount: z.number().optional().describe('Total gross outlay amount in USD'),
    total_budgetary_resources: z.number().optional().describe('Total budgetary resources in USD'),
    fiscal_year: z.number().optional().describe('Fiscal year of the financial data'),
    children: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Treasury Account Symbol title'),
            code: z
              .string()
              .optional()
              .describe(
                'Full Treasury Account Symbol (e.g., 080-2020/2021-0120-000) — the availability-period-scoped component of this federal account, not an account_code accepted by this tool',
              ),
            obligated_amount: z
              .number()
              .optional()
              .describe('Obligated amount in USD for this Treasury Account Symbol'),
            gross_outlay_amount: z
              .number()
              .optional()
              .describe('Gross outlay amount in USD for this Treasury Account Symbol'),
            budgetary_resources_amount: z
              .number()
              .optional()
              .describe('Budgetary resources in USD for this Treasury Account Symbol'),
          })
          .describe('Treasury Account Symbol component with its own financial amounts'),
      )
      .optional()
      .describe(
        'Treasury Account Symbol (TAS) components that make up this federal account, each with its own obligated, outlay, and budgetary-resource amounts. Omitted when the upstream returns none.',
      ),
  }),

  errors: [
    {
      reason: 'account_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No federal account found for the given account code.',
      recovery:
        'Look the code up with usaspending_search_federal_accounts and pass its account_number value. Verify the AGENCY-MAIN format (e.g., 097-0100).',
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
    ctx.log.info('usaspending_get_federal_account', { account_code: input.account_code });
    const svc = getUSASpendingService();

    const account = await svc.getFederalAccount(input.account_code, ctx);

    if (!account?.account_title) {
      throw ctx.fail('account_not_found', `Federal account not found: ${input.account_code}`, {
        recovery: {
          hint: 'Search for the account with usaspending_search_federal_accounts and pass the account_number it returns. Format: AGENCY-MAIN (e.g., 097-0100).',
        },
      });
    }

    const children = (account.children ?? []).map((c) => ({
      ...(c.name ? { name: c.name } : {}),
      ...(c.code ? { code: c.code } : {}),
      ...(typeof c.obligated_amount === 'number' ? { obligated_amount: c.obligated_amount } : {}),
      ...(typeof c.gross_outlay_amount === 'number'
        ? { gross_outlay_amount: c.gross_outlay_amount }
        : {}),
      ...(typeof c.budgetary_resources_amount === 'number'
        ? { budgetary_resources_amount: c.budgetary_resources_amount }
        : {}),
    }));

    return {
      ...(account.account_title ? { account_title: account.account_title } : {}),
      ...(account.federal_account_code
        ? { federal_account_code: account.federal_account_code }
        : {}),
      ...(account.agency_identifier ? { agency_identifier: account.agency_identifier } : {}),
      ...(account.main_account_code ? { main_account_code: account.main_account_code } : {}),
      ...(account.parent_agency_name ? { parent_agency_name: account.parent_agency_name } : {}),
      ...(account.bureau_name ? { bureau_name: account.bureau_name } : {}),
      ...(typeof account.total_obligated_amount === 'number'
        ? { total_obligated_amount: account.total_obligated_amount }
        : {}),
      ...(typeof account.total_gross_outlay_amount === 'number'
        ? { total_gross_outlay_amount: account.total_gross_outlay_amount }
        : {}),
      ...(typeof account.total_budgetary_resources === 'number'
        ? { total_budgetary_resources: account.total_budgetary_resources }
        : {}),
      ...(typeof account.fiscal_year === 'number' ? { fiscal_year: account.fiscal_year } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Federal Account: ${result.account_title ?? result.federal_account_code ?? 'Unknown'}`,
    ];
    if (result.federal_account_code) lines.push(`**Code:** ${result.federal_account_code}`);
    if (result.agency_identifier) lines.push(`**Agency Identifier:** ${result.agency_identifier}`);
    if (result.main_account_code) lines.push(`**Main Account Code:** ${result.main_account_code}`);
    if (result.parent_agency_name) lines.push(`**Parent Agency:** ${result.parent_agency_name}`);
    if (result.bureau_name) lines.push(`**Bureau:** ${result.bureau_name}`);
    if (result.fiscal_year) lines.push(`**Fiscal Year:** ${result.fiscal_year}`);

    if (
      typeof result.total_obligated_amount === 'number' ||
      typeof result.total_gross_outlay_amount === 'number' ||
      typeof result.total_budgetary_resources === 'number'
    ) {
      lines.push('\n### Financial Totals');
      if (typeof result.total_budgetary_resources === 'number')
        lines.push(
          `- **Budgetary Resources:** $${result.total_budgetary_resources.toLocaleString()}`,
        );
      if (typeof result.total_obligated_amount === 'number')
        lines.push(`- **Total Obligated:** $${result.total_obligated_amount.toLocaleString()}`);
      if (typeof result.total_gross_outlay_amount === 'number')
        lines.push(
          `- **Total Gross Outlays:** $${result.total_gross_outlay_amount.toLocaleString()}`,
        );
    }

    if (result.children?.length) {
      lines.push('\n### Treasury Account Symbols');
      lines.push('| TAS | Name | Obligated | Gross Outlays | Budgetary Resources |');
      lines.push('|:----|:-----|:----------|:--------------|:--------------------|');
      for (const c of result.children) {
        const obligated =
          typeof c.obligated_amount === 'number'
            ? `$${c.obligated_amount.toLocaleString()}`
            : 'N/A';
        const outlay =
          typeof c.gross_outlay_amount === 'number'
            ? `$${c.gross_outlay_amount.toLocaleString()}`
            : 'N/A';
        const resources =
          typeof c.budgetary_resources_amount === 'number'
            ? `$${c.budgetary_resources_amount.toLocaleString()}`
            : 'N/A';
        lines.push(
          `| ${c.code ?? 'N/A'} | ${c.name ?? 'N/A'} | ${obligated} | ${outlay} | ${resources} |`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
