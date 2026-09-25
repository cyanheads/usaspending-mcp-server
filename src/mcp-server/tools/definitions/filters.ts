/**
 * @fileoverview Shared filter builder for USAspending analytics endpoints.
 * @module mcp-server/tools/definitions/filters
 */

import { type DateRange, resolveDateRange } from './dates.js';

/**
 * Builds the `filters` object for spending analytics endpoints (geography,
 * category, over-time), and returns the time window it sent — padded, with a
 * lone start or end filled per {@link resolveDateRange} — so the calling tool
 * can echo exactly what was applied and disclose a filled bound.
 */
export function buildFilters(
  f?: {
    keywords?: string[] | undefined;
    award_type_codes?: string[] | undefined;
    agency_name?: string | undefined;
    recipient_id?: string | undefined;
    naics_codes?: string[] | undefined;
    time_period_start?: string | undefined;
    time_period_end?: string | undefined;
  } | null,
): { filters: Record<string, unknown>; timePeriod: DateRange | undefined } {
  const filters: Record<string, unknown> = {};
  if (!f) return { filters, timePeriod: undefined };
  if (f.keywords?.length) filters.keywords = f.keywords;
  if (f.award_type_codes?.length) filters.award_type_codes = f.award_type_codes;
  if (f.agency_name) {
    filters.agencies = [{ type: 'awarding', tier: 'toptier', name: f.agency_name }];
  }
  if (f.recipient_id) filters.recipient_id = f.recipient_id;
  if (f.naics_codes?.length) filters.naics_codes = { require: f.naics_codes };
  const timePeriod = resolveDateRange(f.time_period_start, f.time_period_end);
  if (timePeriod) {
    filters.time_period = [{ start_date: timePeriod.start_date, end_date: timePeriod.end_date }];
  }
  return { filters, timePeriod };
}
