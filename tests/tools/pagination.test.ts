/**
 * @fileoverview Tests for the shared pagination helpers — the three-boundary
 * contract of `resolveHasNext()`, which was previously covered only incidentally
 * through the two tools that consume it.
 * @module tests/tools/pagination.test
 */

import { describe, expect, it } from 'vitest';
import { resolveHasNext } from '@/mcp-server/tools/definitions/pagination.js';

describe('resolveHasNext', () => {
  it('honors a truthful upstream flag on an interior full page', () => {
    expect(resolveHasNext(true, 10, 10)).toBe(true);
  });

  it('forces continuation on a full page the upstream calls the end', () => {
    // The defect this guard exists for: a full page reporting hasNext: false reads
    // as a clean end-of-results and strands every remaining match.
    expect(resolveHasNext(false, 10, 10)).toBe(true);
  });

  it('marks the end on a short page', () => {
    expect(resolveHasNext(false, 3, 10)).toBe(false);
  });

  it('marks the end on an empty page', () => {
    expect(resolveHasNext(false, 0, 10)).toBe(false);
  });

  it('keeps a short page continuing when the upstream says more remain', () => {
    // A partial page with more behind it is legal — the upstream flag still wins.
    expect(resolveHasNext(true, 3, 10)).toBe(true);
  });

  it('treats a missing upstream flag as no continuation', () => {
    expect(resolveHasNext(undefined, 3, 10)).toBe(false);
    expect(resolveHasNext(null, 3, 10)).toBe(false);
  });

  it('still forces continuation on a full page when the flag is missing', () => {
    expect(resolveHasNext(undefined, 10, 10)).toBe(true);
  });

  it('treats an over-full page as full', () => {
    // Upstream occasionally returns more rows than requested; that is still a
    // page worth continuing past, not an end-of-results signal.
    expect(resolveHasNext(false, 11, 10)).toBe(true);
  });
});
