/**
 * @fileoverview Tests for the shared currency formatter — the sign placement
 * contract every monetary site in `format()` output now routes through.
 * @module tests/tools/formatting.test
 */

import { describe, expect, it } from 'vitest';
import { formatCurrency } from '@/mcp-server/tools/definitions/formatting.js';

describe('formatCurrency', () => {
  it('puts the sign outside the currency symbol on a negative amount', () => {
    // The defect this exists for: `$-264,436.97` reads as a typo rather than a
    // reduction. Deobligations and downward contract modifications make this a
    // routine value, not an edge case.
    expect(formatCurrency(-264_436.97)).toBe('-$264,436.97');
  });

  it('renders a positive amount with grouped digits and no sign', () => {
    expect(formatCurrency(2_856_870_495_687.04)).toBe('$2,856,870,495,687.04');
  });

  it('renders zero without a sign', () => {
    expect(formatCurrency(0)).toBe('$0');
  });

  it('renders negative zero without a sign', () => {
    expect(formatCurrency(-0)).toBe('$0');
  });

  it('renders a sub-dollar negative amount', () => {
    expect(formatCurrency(-0.5)).toBe('-$0.5');
  });
});
