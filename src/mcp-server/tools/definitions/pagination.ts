/**
 * @fileoverview Shared pagination helpers — the `format()` summary line and the
 * page-fullness continuation guard for endpoints that under-report `hasNext`.
 * @module mcp-server/tools/definitions/pagination
 */

/**
 * Resolves the continuation flag for endpoints whose `hasNext` under-reports: one
 * USAspending endpoint, `search/spending_by_award/`, returns a full page while
 * reporting `hasNext: false`, which reads as a clean end-of-results and strands every
 * remaining match. A full page (`shown >= limit`) forces continuation; a short or
 * empty page marks the end.
 *
 * Keyed off page fullness rather than an offset threshold, because that endpoint keeps
 * under-reporting on every subsequent page instead of recovering at a fixed point. The
 * tradeoff is an exactly-full final page reporting one page more than exists — an extra
 * round trip instead of silently truncated results.
 *
 * Apply it only where the flag is known to lie, or where no independent cross-check
 * exists. Every other paginated endpoint on this server was verified truthful, and a
 * fullness guard over a truthful flag yields a wrong `has_next: true` on any result set
 * whose size is an exact multiple of `limit`.
 */
export function resolveHasNext(
  upstreamHasNext: boolean | null | undefined,
  shown: number,
  limit: number,
): boolean {
  return (upstreamHasNext ?? false) || shown >= limit;
}

/**
 * Renders the pagination summary segment shared by paginated tools' `format()`:
 * `**Page:** <page> | **Total items:** ~<total> | **Per page:** <limit> | **Has next:** <Yes|No>`.
 *
 * The upstream total is labeled as an item count and kept distinct from the page number.
 * Interpolating it as `Page: <page> of ~<total>` misreads in `content[]` as a total page
 * count (e.g. "Page: 100 of ~200" beside "Has next: No"), even though `<total>` is the item
 * count carried in `structuredContent`. The `**Total items:**` clause is omitted when the
 * upstream total is unknown. Centralized here because the same defect recurred across six tools.
 *
 * `total` is rendered with `.toLocaleString()` for readability on large counts, matching this
 * codebase's convention for other large numeric fields (obligation/outlay/amount, etc.). The
 * format-parity linter tolerates locale digit-group separators (commas) when matching a
 * field's sentinel value, so this doesn't affect parity.
 */
export function formatPaginationLine(pm: {
  page: number;
  limit: number;
  has_next: boolean;
  total?: number | undefined;
}): string {
  const totalItems =
    pm.total !== undefined ? ` | **Total items:** ~${pm.total.toLocaleString()}` : '';
  return `**Page:** ${pm.page}${totalItems} | **Per page:** ${pm.limit} | **Has next:** ${pm.has_next ? 'Yes' : 'No'}`;
}
