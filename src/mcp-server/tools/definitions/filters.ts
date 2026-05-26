/**
 * @fileoverview Shared filter builder for USAspending analytics endpoints.
 * @module mcp-server/tools/definitions/filters
 */

/** Builds the `filters` object for spending analytics endpoints (geography, category, over-time). */
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
): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (!f) return filters;
  if (f.keywords?.length) filters.keywords = f.keywords;
  if (f.award_type_codes?.length) filters.award_type_codes = f.award_type_codes;
  if (f.agency_name) {
    filters.agencies = [{ type: 'awarding', tier: 'toptier', name: f.agency_name }];
  }
  if (f.recipient_id) filters.recipient_id = f.recipient_id;
  if (f.naics_codes?.length) filters.naics_codes = { require: f.naics_codes };
  if (f.time_period_start && f.time_period_end) {
    filters.time_period = [{ start_date: f.time_period_start, end_date: f.time_period_end }];
  }
  return filters;
}
