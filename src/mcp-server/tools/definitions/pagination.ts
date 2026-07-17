/**
 * @fileoverview Shared pagination-line renderer for paginated tool `format()` output.
 * @module mcp-server/tools/definitions/pagination
 */

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
