/**
 * @fileoverview Tool to fetch a recipient's full profile by recipient ID.
 * @module mcp-server/tools/definitions/get-recipient.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { countLimit, LimitClampSchema, limitClampTrailer } from './count-limit.js';
import { formatCurrency } from './formatting.js';
import {
  renderUnavailableSections,
  settleSection,
  type UnavailableSection,
  unavailableNotice,
  unavailableSectionSchema,
} from './unavailable-sections.js';

/**
 * `recipient/children/` returns every child in one response: 217 for the largest
 * family measured, 159 of them at $0, about 37 KB per surface.
 */
const CHILDREN_LIMIT = countLimit({ tool: 'usaspending_get_recipient', default: 50, cap: 500 });

const UnavailableSectionSchema = unavailableSectionSchema(
  ['children'],
  'children: the child recipients of a parent profile (children, children_total).',
);

interface RankedChild {
  amount?: number;
  name?: string;
}

/**
 * Highest amount first, ties by name, a child without an amount last. Upstream
 * orders children by transaction count and appends zero-amount affiliates.
 */
function byAmountDesc(a: RankedChild, b: RankedChild): number {
  if (a.amount !== b.amount) {
    if (a.amount === undefined) return 1;
    if (b.amount === undefined) return -1;
    return b.amount - a.amount;
  }
  const x = a.name ?? '';
  const y = b.name ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

export const getRecipientTool = tool('usaspending_get_recipient', {
  title: 'Get Recipient Profile',
  description:
    "Fetch a recipient's full profile including address, business type codes, parent organizations, alternate names, and total transaction and loan amounts. A -P ID covers awards USAspending attributes to that parent, and historical attribution can vary. A -C ID covers the entity's own awards recorded with a parent, and a -R ID covers its own awards recorded without one. Use IDs returned by usaspending_search_recipients or usaspending_get_award. If search returns both -C and -R for the entity, check both. Never construct an ID by replacing a suffix. Totals cover the trailing 12 months by default. Set fiscal_year to one year or \"all\" for USAspending's searchable history through the request date. The period field names the window. parents lists every parent organization — a child often has several, and a parent lists itself — and each parent_id opens that parent in usaspending_get_recipient. For a -P parent, children lists its child recipients with their amounts over the same period, highest amount first, up to children_limit, and children_total counts them all; children is a best-effort second request, so when it fails the profile is still returned and unavailable_sections names children with its reason. For a recipient's totals by award type, use usaspending_spending_over_time with filters.recipient_id and award_type_codes. UEI and DUNS values can be used to cross-reference with SAM.gov and SEC EDGAR.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    recipient_id: z
      .string()
      .min(1)
      .describe(
        'Recipient hexadecimal 8-4-4-4-12 hash with level suffix, e.g., b97d19b0-833c-8d8f-3a2c-157d04ea55ef-P — from usaspending_search_recipients or usaspending_get_award',
      ),
    fiscal_year: z
      .preprocess(
        (value) => {
          // Preserve the framework's exact numeric-string repair when adding a string branch.
          if (typeof value !== 'string') return value;
          const trimmed = value.trim();
          const year = Number(trimmed);
          return Number.isFinite(year) && String(year) === trimmed ? year : value;
        },
        z.union([z.number().int().min(2001).max(2030), z.literal('all')]),
      )
      .optional()
      .describe(
        'Fiscal year to scope the totals to (e.g., 2024, which runs October 2023 through September 2024). Use "all" for searchable history through the request date. Omit for the trailing 12 months.',
      ),
    children_limit: CHILDREN_LIMIT.schema.describe(
      'Child recipients to return for a parent (-P) profile, highest amount first. Default 50, at most 500 per call. Ignored for -C and -R profiles.',
    ),
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
    parent_id: z
      .string()
      .optional()
      .describe(
        'Hash ID of the first parents entry (ends in -P) — pass to usaspending_get_recipient for that parent profile. Absent for a standalone (-R) recipient.',
      ),
    parent_name: z
      .string()
      .optional()
      .describe(
        "Name of the first parents entry, which can be the recipient's own parent-level record; parents lists every parent",
      ),
    parent_uei: z.string().optional().describe('UEI of the first parents entry'),
    parents: z
      .array(
        z
          .object({
            parent_id: z
              .string()
              .optional()
              .describe(
                'Parent recipient hash ID (ends in -P) — pass to usaspending_get_recipient for the parent profile',
              ),
            parent_name: z.string().optional().describe('Parent organization name'),
            parent_uei: z.string().optional().describe('Parent organization UEI'),
            parent_duns: z.string().optional().describe('Parent organization DUNS (legacy)'),
          })
          .describe('One parent organization; a member upstream leaves empty is omitted'),
      )
      .optional()
      .describe(
        'Every parent organization of the recipient, in upstream order: a child (-C) often has several and can list its own parent-level record, and a parent (-P) lists itself. Absent for a standalone (-R) recipient.',
      ),
    business_types: z.array(z.string()).optional().describe('Business type codes'),
    location: z
      .object({
        address_line1: z.string().optional().describe('Street address line 1'),
        address_line2: z.string().optional().describe('Street address line 2'),
        city_name: z.string().optional().describe('City'),
        state_code: z.string().optional().describe('State code'),
        zip: z.string().optional().describe('ZIP code'),
        zip4: z.string().optional().describe('ZIP+4 extension'),
        country_code: z.string().optional().describe('Country code'),
      })
      .optional()
      .describe('Recipient address'),
    period: z
      .string()
      .describe(
        'Window the totals cover: FY<year> for a single fiscal year, "all fiscal years" for searchable history through the request date, or "trailing 12 months" when fiscal_year is omitted',
      ),
    total_transaction_amount: z
      .number()
      .optional()
      .describe('Total transaction (award) amount in USD over period, across all award types'),
    total_transactions: z
      .number()
      .optional()
      .describe('Total number of award transactions over period'),
    total_face_value_loan_amount: z
      .number()
      .optional()
      .describe('Total face value of loans in USD over period'),
    total_face_value_loan_transactions: z
      .number()
      .optional()
      .describe('Number of face-value loan transactions over period'),
    alternate_names: z.array(z.string()).optional().describe('Alternate business names'),
    children: z
      .array(
        z
          .object({
            recipient_id: z
              .string()
              .optional()
              .describe(
                'Child recipient hash ID (ends in -C) — pass to usaspending_get_recipient for its profile',
              ),
            name: z.string().optional().describe('Child recipient name'),
            uei: z.string().optional().describe('Child recipient UEI'),
            duns: z.string().optional().describe('Child recipient DUNS (legacy)'),
            amount: z
              .number()
              .optional()
              .describe('Transaction amount in USD over period; can be negative'),
            state_province: z.string().optional().describe('State or province code'),
          })
          .describe('One child recipient; a member upstream leaves empty is omitted'),
      )
      .optional()
      .describe(
        'Child recipients of a parent (-P) over period, highest amount first, up to children_limit. A single fiscal year or the trailing 12 months can include affiliates with no transactions at 0. [] when the parent has none. Absent for -C and -R recipients, and when the children request failed (see unavailable_sections).',
      ),
    children_total: z
      .number()
      .optional()
      .describe(
        'Number of child recipients the parent has over period, before children_limit. Present whenever children is.',
      ),
  }),

  // Agent-facing context: the children request's failure, its children_limit clamp, and its truncation.
  enrichment: {
    unavailable_sections: z
      .array(UnavailableSectionSchema)
      .optional()
      .describe(
        'Sections omitted because their request failed while the profile loaded. Absent when every section loaded.',
      ),
    limitClamp: LimitClampSchema,
    truncated: z.boolean().optional().describe('True when children was cut to children_limit.'),
    shown: z.number().optional().describe('Number of child recipients returned.'),
    cap: z.number().optional().describe('The children_limit applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'A reduced children_limit, how to see child recipients cut by children_limit, and which sections failed to load and whether a retry may recover them. Absent when none applies.',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (notice) => (notice ? `> ${escapeMarkdownInline(notice)}` : '') },
    unavailable_sections: { render: renderUnavailableSections },
    limitClamp: limitClampTrailer,
  },

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
      thrownBy: 'service',
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
    },
    {
      reason: 'api_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'USAspending.gov did not respond before the request deadline elapsed.',
      retryable: true,
      thrownBy: 'service',
      recovery: 'Retry the request after a few seconds; USAspending was slow to build the profile.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_get_recipient', { recipient_id: input.recipient_id });
    const svc = getUSASpendingService();
    const { fiscal_year } = input;
    const period = fiscal_year !== undefined ? { fiscal_year } : {};
    let periodLabel = 'trailing 12 months';
    if (fiscal_year === 'all') periodLabel = 'all fiscal years';
    else if (fiscal_year !== undefined) periodLabel = `FY${fiscal_year}`;
    // The children request chains after the profile and ends inside the profile request's deadline.
    const deadlineAt = svc.requestDeadline();
    const r = await svc.getRecipient(input.recipient_id, period, ctx);

    if (!r?.name) {
      throw ctx.fail('recipient_not_found', `Recipient not found: ${input.recipient_id}`);
    }

    const parents = (r.parents ?? []).flatMap((p) => {
      const entry = {
        ...(p.parent_id ? { parent_id: p.parent_id } : {}),
        ...(p.parent_name ? { parent_name: p.parent_name } : {}),
        ...(p.parent_uei ? { parent_uei: p.parent_uei } : {}),
        ...(p.parent_duns ? { parent_duns: p.parent_duns } : {}),
      };
      return Object.keys(entry).length > 0 ? [entry] : [];
    });

    /**
     * Children exist only for a -P parent, keyed by its UEI or DUNS: a -R
     * recipient's UEI answers with the recipient itself as a child, so the level
     * gates the request. The request is best-effort: a failure returns the profile
     * with children disclosed in unavailable_sections, while caller cancellation and
     * unclassified errors rethrow. The profile already proved the recipient exists,
     * so a children 400 is upstream_error, never recipient_not_found.
     */
    const unavailable: UnavailableSection<'children'>[] = [];
    const childrenKey = r.recipient_level === 'P' ? r.uei || r.duns : undefined;
    if (r.recipient_level === 'P' && !childrenKey) {
      unavailable.push({
        section: 'children',
        reason: 'upstream_error',
        retryable: false,
        message:
          'USAspending lists children by the parent UEI or DUNS, and this parent profile carries neither.',
      });
    }
    const [childrenLeg] = childrenKey
      ? await Promise.allSettled([svc.getRecipientChildren(childrenKey, period, ctx, deadlineAt)])
      : [];
    const ranked = (childrenLeg && settleSection(ctx, 'children', childrenLeg, unavailable))
      ?.map((c) => ({
        ...(c.recipient_id ? { recipient_id: c.recipient_id } : {}),
        ...(c.name ? { name: c.name } : {}),
        ...(c.uei ? { uei: c.uei } : {}),
        ...(c.duns ? { duns: c.duns } : {}),
        ...(typeof c.amount === 'number' ? { amount: c.amount } : {}),
        ...(c.state_province ? { state_province: c.state_province } : {}),
      }))
      .sort(byAmountDesc);

    // `ctx.enrich.notice` is last-wins and `truncated()` writes it too, so every notice joins into one call after both.
    const notices: string[] = [];
    let listed: { children: NonNullable<typeof ranked>; children_total: number } | undefined;
    if (ranked) {
      // children_limit is read only when children were listed, so a -C, -R, or failed read reports no clamp.
      const limit = CHILDREN_LIMIT.apply(ctx, 'children_limit', input.children_limit);
      if (limit.notice) notices.push(limit.notice);
      listed = { children: ranked.slice(0, limit.applied), children_total: ranked.length };
      if (ranked.length > limit.applied) {
        const shown = listed.children.length;
        const guidance = `Showing the ${shown} highest-amount of ${ranked.length} child recipients. ${limit.applied < CHILDREN_LIMIT.cap ? `Raise children_limit (at most ${CHILDREN_LIMIT.cap}) to see more.` : `${CHILDREN_LIMIT.cap} is the most one call returns.`}`;
        ctx.enrich.truncated({ shown, cap: limit.applied, guidance });
        notices.push(guidance);
      }
    }
    if (unavailable.length > 0) {
      ctx.enrich({ unavailable_sections: unavailable });
      notices.push(unavailableNotice(unavailable));
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    const location = r.location
      ? {
          ...(r.location.address_line1 ? { address_line1: r.location.address_line1 } : {}),
          ...(r.location.address_line2 ? { address_line2: r.location.address_line2 } : {}),
          ...(r.location.city_name ? { city_name: r.location.city_name } : {}),
          ...(r.location.state_code ? { state_code: r.location.state_code } : {}),
          ...(r.location.zip ? { zip: r.location.zip } : {}),
          ...(r.location.zip4 ? { zip4: r.location.zip4 } : {}),
          ...(r.location.country_code ? { country_code: r.location.country_code } : {}),
        }
      : {};

    return {
      name: r.name,
      period: periodLabel,
      ...(r.uei ? { uei: r.uei } : {}),
      ...(r.duns ? { duns: r.duns } : {}),
      ...(r.recipient_id ? { recipient_id: r.recipient_id } : {}),
      ...(r.recipient_level ? { recipient_level: r.recipient_level } : {}),
      ...(r.parent_id ? { parent_id: r.parent_id } : {}),
      ...(r.parent_name ? { parent_name: r.parent_name } : {}),
      ...(r.parent_uei ? { parent_uei: r.parent_uei } : {}),
      ...(parents.length > 0 ? { parents } : {}),
      ...(r.business_types?.length ? { business_types: r.business_types } : {}),
      ...(Object.keys(location).length > 0 ? { location } : {}),
      ...(typeof r.total_transaction_amount === 'number'
        ? { total_transaction_amount: r.total_transaction_amount }
        : {}),
      ...(typeof r.total_transactions === 'number'
        ? { total_transactions: r.total_transactions }
        : {}),
      ...(typeof r.total_face_value_loan_amount === 'number'
        ? { total_face_value_loan_amount: r.total_face_value_loan_amount }
        : {}),
      ...(typeof r.total_face_value_loan_transactions === 'number'
        ? { total_face_value_loan_transactions: r.total_face_value_loan_transactions }
        : {}),
      ...(r.alternate_names?.length ? { alternate_names: r.alternate_names } : {}),
      ...listed,
    };
  },

  format: (result) => {
    const lines: string[] = [`## Recipient: ${escapeMarkdownInline(result.name ?? 'Unknown')}`];
    lines.push(`**Period:** ${escapeMarkdownInline(result.period)}`);
    if (result.recipient_id)
      lines.push(`**Recipient ID:** ${escapeMarkdownInline(result.recipient_id)}`);
    if (result.uei) lines.push(`**UEI:** ${escapeMarkdownInline(result.uei)}`);
    if (result.duns) lines.push(`**DUNS:** ${escapeMarkdownInline(result.duns)}`);
    if (result.recipient_level)
      lines.push(`**Level:** ${escapeMarkdownInline(result.recipient_level)}`);
    if (result.parent_name)
      lines.push(`**Parent Org:** ${escapeMarkdownInline(result.parent_name)}`);
    if (result.parent_uei) lines.push(`**Parent UEI:** ${escapeMarkdownInline(result.parent_uei)}`);
    if (result.parent_id)
      lines.push(`**Parent ID (for get_recipient):** ${escapeMarkdownInline(result.parent_id)}`);
    if (result.location) {
      const loc = result.location;
      const zip = [loc.zip, loc.zip4].filter(Boolean).join('-');
      const addr = [
        loc.address_line1,
        loc.address_line2,
        loc.city_name,
        loc.state_code,
        zip || undefined,
        loc.country_code,
      ]
        .filter(Boolean)
        .join(', ');
      if (addr) lines.push(`**Address:** ${escapeMarkdownInline(addr)}`);
    }
    if (result.business_types?.length)
      lines.push(
        `**Business Type Codes:** ${escapeMarkdownInline(result.business_types.join(', '))}`,
      );
    if (result.alternate_names?.length) {
      lines.push(`**Alternate Names:** ${escapeMarkdownInline(result.alternate_names.join(', '))}`);
    }

    const hasTotals =
      typeof result.total_transaction_amount === 'number' ||
      typeof result.total_transactions === 'number' ||
      typeof result.total_face_value_loan_amount === 'number' ||
      typeof result.total_face_value_loan_transactions === 'number';
    if (hasTotals) {
      lines.push('\n### Award Totals');
      if (typeof result.total_transaction_amount === 'number')
        lines.push(
          `- **Total Transaction Amount:** ${formatCurrency(result.total_transaction_amount)}`,
        );
      if (typeof result.total_transactions === 'number')
        lines.push(`- **Total Transactions:** ${result.total_transactions.toLocaleString()}`);
      if (typeof result.total_face_value_loan_amount === 'number')
        lines.push(
          `- **Face Value of Loans:** ${formatCurrency(result.total_face_value_loan_amount)}`,
        );
      if (typeof result.total_face_value_loan_transactions === 'number')
        lines.push(
          `- **Face Value Loan Transactions:** ${result.total_face_value_loan_transactions.toLocaleString()}`,
        );
    }

    const cell = (value: string | undefined) => escapeMarkdownInline(value ?? 'N/A');
    if (result.parents?.length) {
      lines.push('\n### Parents');
      lines.push('| Parent | Recipient ID | UEI | DUNS |');
      lines.push('|:-------|:-------------|:----|:-----|');
      for (const p of result.parents) {
        lines.push(
          `| ${cell(p.parent_name)} | ${cell(p.parent_id)} | ${cell(p.parent_uei)} | ${cell(p.parent_duns)} |`,
        );
      }
    }
    if (result.children) {
      lines.push('\n### Child Recipients');
      lines.push(`**Children:** ${result.children.length} of ${result.children_total}`);
      if (result.children.length > 0) {
        lines.push('| Recipient | Recipient ID | UEI | DUNS | State | Amount |');
        lines.push('|:----------|:-------------|:----|:-----|:------|:-------|');
        for (const c of result.children) {
          const amount = typeof c.amount === 'number' ? formatCurrency(c.amount) : 'N/A';
          lines.push(
            `| ${cell(c.name)} | ${cell(c.recipient_id)} | ${cell(c.uei)} | ${cell(c.duns)} | ${cell(c.state_province)} | ${amount} |`,
          );
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
