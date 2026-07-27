/**
 * @fileoverview Shared value formatters for tool `format()` output.
 * @module mcp-server/tools/definitions/formatting
 */

/**
 * Renders a dollar amount with the sign outside the currency symbol:
 * `-$264,436.97`, not `$-264,436.97`.
 *
 * Negative amounts are ordinary in this data — a deobligation or a downward
 * contract modification reports the reduction as a negative obligation, and
 * `search/spending_over_time/` returns negative award-type columns for real
 * fiscal years. Interpolating such a value straight into `$${n}` puts the minus
 * between the symbol and the digits, which reads as a typo rather than a
 * reduction.
 *
 * Digit grouping stays on `.toLocaleString()`, matching how every other large
 * number on this server renders. The format-parity linter tolerates locale
 * separators when matching a field's sentinel value, so routing a currency site
 * through here does not affect parity.
 */
export function formatCurrency(amount: number): string {
  return `${amount < 0 ? '-' : ''}$${Math.abs(amount).toLocaleString()}`;
}
