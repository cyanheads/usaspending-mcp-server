/**
 * @fileoverview Shared filter builder for USAspending analytics endpoints, and the
 * program, product/service, and emergency-funding code filters shared by
 * `usaspending_search_awards` and the three spending analytics tools.
 * @module mcp-server/tools/definitions/filters
 */

import { z } from '@cyanheads/mcp-ts-core';
import { type DateRange, resolveDateRange } from './dates.js';

/** Assistance Listing (CFDA) number: two digits, a dot, three digits or capitals (`11.67A`). */
const ASSISTANCE_LISTING_PATTERN = /^\d{2}\.[0-9A-Z]{3}$/;

/** Product and Service Code, or a prefix of one: 1–4 letters or digits, either case. */
const PSC_CODE_PATTERN = /^[0-9A-Za-z]{1,4}$/;

/** Disaster Emergency Fund Code: 1–3 letters or digits, either case. */
const DEF_CODE_PATTERN = /^[0-9A-Za-z]{1,3}$/;

/**
 * Award type codes by the groups `search/spending_by_award/` accepts one at a
 * time — the partition its mixed-group 422 lists, F-codes and -1 included.
 */
export const AWARD_TYPE_CODES = {
  contracts: ['A', 'B', 'C', 'D'],
  idvs: ['IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E'],
  grants: ['02', '03', '04', '05', 'F001', 'F002'],
  direct_payments: ['06', '10', 'F006', 'F007'],
  loans: ['07', '08', 'F003', 'F004'],
  other: ['09', '11', '-1', 'F005', 'F008', 'F009', 'F010'],
} satisfies Record<string, readonly string[]>;

/** Contract and IDV award type codes — the awards that carry a PSC and no Assistance Listing. */
export const PROCUREMENT_AWARD_TYPE_CODES: ReadonlySet<string> = new Set([
  ...AWARD_TYPE_CODES.contracts,
  ...AWARD_TYPE_CODES.idvs,
]);

/**
 * Grant, direct payment, loan, and other assistance award type codes — the
 * awards that carry an Assistance Listing and no PSC.
 */
export const ASSISTANCE_AWARD_TYPE_CODES: ReadonlySet<string> = new Set([
  ...AWARD_TYPE_CODES.grants,
  ...AWARD_TYPE_CODES.direct_payments,
  ...AWARD_TYPE_CODES.loans,
  ...AWARD_TYPE_CODES.other,
]);

/**
 * The three code filters, keyed as every tool that takes them declares them.
 * One instance per key, spread into each tool's input, so `tools/list`
 * describes them identically everywhere.
 */
export const CODE_FILTER_FIELDS = {
  assistance_listings: z
    .array(
      z
        .string()
        .regex(
          ASSISTANCE_LISTING_PATTERN,
          'Expected an Assistance Listing number as NN.NNN (e.g. 93.866 or 11.67A)',
        )
        .describe('Assistance Listing number, e.g. 15.507'),
    )
    .optional()
    .describe(
      'Filter by Assistance Listing (CFDA) program numbers, e.g. ["15.507"]: two digits, a dot, then three digits or capital letters (11.67A). Matches an award when any of its listings equals one of these exactly; several values match any of them. A matching award\'s primary listing can differ from the one requested, and amounts cover the whole award, not that listing\'s share. Only assistance awards (grants, direct payments, loans, other assistance) carry listings, so a call whose award types are all contracts or IDVs — including a contract default — is rejected as assistance_listings_type_mismatch. Use usaspending_autocomplete_filters type=cfda to look up numbers.',
    ),
  psc_codes: z
    .array(
      z
        .string()
        .regex(PSC_CODE_PATTERN, 'Expected a Product and Service Code of 1–4 letters or digits')
        .describe('Product and Service Code or prefix, e.g. Y1NE or Y1'),
    )
    .optional()
    .describe(
      'Filter by Product and Service Codes (PSC), e.g. ["Y1NE"]: 1–4 letters or digits, sent uppercased. A shorter code covers every code under it ("Y1" covers "Y1NE"); several values match any of them. Only contracts and IDVs carry a PSC, so a call whose award types are all assistance types is rejected as psc_codes_type_mismatch, and pairing psc_codes with assistance_listings matches nothing, since no award carries both. Use usaspending_autocomplete_filters type=psc to look up codes.',
    ),
  def_codes: z
    .array(
      z
        .string()
        .regex(DEF_CODE_PATTERN, 'Expected a DEF code of 1–3 letters or digits')
        .describe('Disaster Emergency Fund Code, e.g. Z or L'),
    )
    .optional()
    .describe(
      'Filter by Disaster Emergency Fund Codes (DEF), e.g. ["Z"], or ["L", "M", "N", "O", "P"] for COVID-19: 1–3 letters or digits, sent uppercased — the codes usaspending_disaster_spending takes and usaspending_get_agency lists. Matches awards of any type funded under any of these codes. Amounts cover the whole matching award, not the share funded by the code, and DEF-filtered totals can be negative. An unknown code is rejected with the list of codes USAspending accepts.',
    ),
};

/** The code filters as a call supplied them; an empty list is unset. */
export interface CodeFilterInput {
  assistance_listings?: string[] | undefined;
  def_codes?: string[] | undefined;
  psc_codes?: string[] | undefined;
}

/** The code filters as sent: uppercased, with an empty list dropped. */
export interface CodeFilters {
  assistance_listings?: string[];
  def_codes?: string[];
  psc_codes?: string[];
}

/** Upstream rejects lowercase PSC and DEF codes and an empty list, so both are normalized away. */
export function normalizeCodeFilters(f: CodeFilterInput): CodeFilters {
  const upper = (codes: string[] | undefined) =>
    codes?.length ? codes.map((code) => code.toUpperCase()) : undefined;
  const listings = f.assistance_listings?.length ? f.assistance_listings : undefined;
  const psc = upper(f.psc_codes);
  const def = upper(f.def_codes);
  return {
    ...(listings ? { assistance_listings: listings } : {}),
    ...(psc ? { psc_codes: psc } : {}),
    ...(def ? { def_codes: def } : {}),
  };
}

/** Writes the code filters into an upstream `filters` object under the endpoint's keys. */
export function applyCodeFilters(filters: Record<string, unknown>, codes: CodeFilters): void {
  if (codes.assistance_listings) filters.program_numbers = codes.assistance_listings;
  if (codes.psc_codes) filters.psc_codes = codes.psc_codes;
  if (codes.def_codes) filters.def_codes = codes.def_codes;
}

/** The code filters sent, as the comma-joined `applied_*` echo every tool carries. */
export function codeFilterEcho(codes: CodeFilters): {
  applied_assistance_listings?: string;
  applied_def_codes?: string;
  applied_psc_codes?: string;
} {
  return {
    ...(codes.assistance_listings
      ? { applied_assistance_listings: codes.assistance_listings.join(', ') }
      : {}),
    ...(codes.psc_codes ? { applied_psc_codes: codes.psc_codes.join(', ') } : {}),
    ...(codes.def_codes ? { applied_def_codes: codes.def_codes.join(', ') } : {}),
  };
}

/** The code filters sent, as `key=value` parts an empty-result notice names. */
export function describeCodeFilters(codes: CodeFilters): string[] {
  return [
    ...(codes.assistance_listings
      ? [`assistance_listings=${codes.assistance_listings.join(',')}`]
      : []),
    ...(codes.psc_codes ? [`psc_codes=${codes.psc_codes.join(',')}`] : []),
    ...(codes.def_codes ? [`def_codes=${codes.def_codes.join(',')}`] : []),
  ];
}

/**
 * Upstream answers a code filter no award type in the call can carry with $0
 * and no message, so an analytics call is rejected when every effective award
 * type is one that cannot match. `awardTypeCodes` undefined means every type,
 * which always can; an unrecognized code is left for upstream to judge.
 * Returns the message for the first filter that cannot match, or `undefined`.
 */
export function analyticsTypeMismatch(
  codes: CodeFilters,
  awardTypeCodes: readonly string[] | undefined,
  field: string,
): { filter: 'assistance_listings' | 'psc_codes'; message: string } | undefined {
  if (!awardTypeCodes?.length) return;
  const list = `${field} [${awardTypeCodes.join(', ')}]`;
  if (
    codes.assistance_listings &&
    awardTypeCodes.every((code) => PROCUREMENT_AWARD_TYPE_CODES.has(code))
  ) {
    return {
      filter: 'assistance_listings',
      message: `assistance_listings match only assistance awards, but ${list} holds only contract and IDV codes, which carry no listings.`,
    };
  }
  if (codes.psc_codes && awardTypeCodes.every((code) => ASSISTANCE_AWARD_TYPE_CODES.has(code))) {
    return {
      filter: 'psc_codes',
      message: `psc_codes match only contracts and IDVs, but ${list} holds only assistance codes, which carry no PSC.`,
    };
  }
  return;
}

/**
 * Builds the `filters` object for spending analytics endpoints (geography,
 * category, over-time), and returns the time window it sent — padded, with a
 * lone start or end filled per {@link resolveDateRange} — so the calling tool
 * can echo exactly what was applied and disclose a filled bound, plus the code
 * filters it sent, normalized per {@link normalizeCodeFilters}.
 */
export function buildFilters(
  f?:
    | ({
        keywords?: string[] | undefined;
        award_type_codes?: string[] | undefined;
        agency_name?: string | undefined;
        recipient_id?: string | undefined;
        naics_codes?: string[] | undefined;
        time_period_start?: string | undefined;
        time_period_end?: string | undefined;
      } & CodeFilterInput)
    | null,
): { filters: Record<string, unknown>; timePeriod: DateRange | undefined; codes: CodeFilters } {
  const filters: Record<string, unknown> = {};
  if (!f) return { filters, timePeriod: undefined, codes: {} };
  if (f.keywords?.length) filters.keywords = f.keywords;
  if (f.award_type_codes?.length) filters.award_type_codes = f.award_type_codes;
  if (f.agency_name) {
    filters.agencies = [{ type: 'awarding', tier: 'toptier', name: f.agency_name }];
  }
  if (f.recipient_id) filters.recipient_id = f.recipient_id;
  if (f.naics_codes?.length) filters.naics_codes = { require: f.naics_codes };
  const codes = normalizeCodeFilters(f);
  applyCodeFilters(filters, codes);
  const timePeriod = resolveDateRange(f.time_period_start, f.time_period_end);
  if (timePeriod) {
    filters.time_period = [{ start_date: timePeriod.start_date, end_date: timePeriod.end_date }];
  }
  return { filters, timePeriod, codes };
}
