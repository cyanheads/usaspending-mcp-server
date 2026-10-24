/**
 * @fileoverview Fiscal-year inputs and reporting periods for federal-account tools.
 * @module mcp-server/tools/definitions/fiscal-year
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Federal fiscal years roll over on October 1; evaluate at validation time. */
function currentFiscalYear(): number {
  const now = new Date();
  return now.getUTCFullYear() + (now.getUTCMonth() >= 9 ? 1 : 0);
}

/** Blank form values mean no year selection; nonblank strings are not year inputs. */
export const accountFiscalYearSchema = z
  .union([
    z
      .number()
      .int()
      .min(2001)
      .refine(
        (year) => year <= currentFiscalYear(),
        'Fiscal year cannot exceed the current federal fiscal year',
      )
      .describe('Integer federal fiscal year from 2001 through the current federal fiscal year'),
    z.string().trim().length(0).describe('Blank form value; leaves the fiscal year unset'),
  ])
  .optional()
  .describe(
    'Federal fiscal year (2001 through the current federal fiscal year; October 1 rollover). Omit or leave blank to preserve the endpoint default.',
  );

/** Parse upstream number/string years without substituting a selected or current year. */
export function normalizeAccountFiscalYear(
  value: number | string | null | undefined,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return z.coerce.number().int().min(2001).parse(value);
}

/** Full financial reporting year, inclusive; these are not award action dates. */
export function accountFiscalYearRange(year: number): { start_date: string; end_date: string } {
  return { start_date: `${year - 1}-10-01`, end_date: `${year}-09-30` };
}
