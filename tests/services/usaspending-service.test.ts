/**
 * @fileoverview Tests for the USAspending service HTTP primitives — the layer the
 * tool suites mock away. Exercises the real service against a stubbed
 * `globalThis.fetch` returning the upstream's actual miss/error shapes.
 * @module tests/services/usaspending-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { USASpendingService } from '@/services/usaspending/usaspending-service.js';

/** The service ignores appConfig and storage — only serverConfig is read. */
const serverConfig: ServerConfig = {
  baseUrl: 'https://api.usaspending.gov/api/v2/',
  timeoutMs: 30_000,
};

const newService = () =>
  new USASpendingService({} as AppConfig, {} as StorageService, serverConfig);

/** Stubs the next fetch with a verbatim upstream response body and status. */
const stubFetch = (status: number, body: string) => {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('USASpendingService entity lookups', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Upstream bodies below are verbatim live responses. Each detail method must
   * resolve to undefined on its miss status so the tool handler's existence
   * check runs and its declared not-found contract fires (#27).
   */
  it('getRecipient resolves undefined on the upstream 400 miss', async () => {
    stubFetch(400, JSON.stringify({ detail: "Recipient ID not found: '00000000-…-R'." }));
    const result = await newService().getRecipient(
      '00000000-0000-0000-0000-000000000000-R',
      {},
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it('getRecipient resolves undefined on a malformed-identifier 400', async () => {
    // A bad recipient-level suffix is a 400, not a 404 — still "no such recipient".
    stubFetch(400, JSON.stringify({ detail: "Invalid Recipient-Level: 'X'" }));
    const result = await newService().getRecipient(
      'b97d19b0-833c-8d8f-3a2c-157d04ea55ef-X',
      {},
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it('getFederalAccount resolves undefined on the upstream 400 miss', async () => {
    stubFetch(
      400,
      JSON.stringify({ detail: "Cannot find Federal Account with the code of '000-0000'" }),
    );
    const result = await newService().getFederalAccount('000-0000', ctx);
    expect(result).toBeUndefined();
  });

  it('getFederalAccount resolves undefined on a malformed-code 404', async () => {
    // A code that fails URL routing answers 404 rather than the 400 a well-formed miss gets.
    stubFetch(404, '<!doctype html><html><body><h1>Not Found</h1></body></html>');
    const result = await newService().getFederalAccount('garbage', ctx);
    expect(result).toBeUndefined();
  });

  it('getAgency resolves undefined on the upstream 404 miss', async () => {
    stubFetch(
      404,
      JSON.stringify({ detail: "Agency with a toptier code of '999' does not exist" }),
    );
    const result = await newService().getAgency('999', ctx);
    expect(result).toBeUndefined();
  });

  it('getAward resolves undefined on the upstream 404 miss', async () => {
    // This endpoint answers a miss with an HTML body, not JSON.
    stubFetch(404, '<!doctype html><html><body><h1>Not Found</h1></body></html>');
    const result = await newService().getAward('NOT_A_REAL_GENERATED_ID_987654', ctx);
    expect(result).toBeUndefined();
  });

  it('returns the parsed body on 200', async () => {
    stubFetch(200, JSON.stringify({ account_title: 'Operation and Maintenance, Navy' }));
    const result = await newService().getFederalAccount('017-1804', ctx);
    expect(result).toEqual({ account_title: 'Operation and Maintenance, Navy' });
  });

  it('propagates a non-miss status instead of reporting the entity as absent', async () => {
    // 422 is what the agency endpoint returns for an out-of-range fiscal_year — a real
    // record with a rejected request, which must never be flattened into "not found".
    stubFetch(
      422,
      JSON.stringify({ detail: "Field 'fiscal_year' value '1899' is below min '2008'" }),
    );
    await expect(newService().getAgency('097', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });
});

describe('USASpendingService non-entity GETs', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * These share the same private get<T>() primitive but have no not-found contract
   * and no handler existence check. Swallowing their 4xx would turn a real upstream
   * failure into an empty success, so the miss mapping must not reach them (#27).
   */
  it('listAgencies still throws on a 404', async () => {
    stubFetch(404, JSON.stringify({ detail: 'Not found' }));
    await expect(newService().listAgencies({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('getAgencySubAgencies still throws on a 400', async () => {
    stubFetch(400, JSON.stringify({ detail: 'Bad request' }));
    await expect(newService().getAgencySubAgencies('097', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  it('getAgencyBudgetaryResources still throws on a 400', async () => {
    stubFetch(400, JSON.stringify({ detail: 'Bad request' }));
    await expect(newService().getAgencyBudgetaryResources('097', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  it('getDisasterOverview still throws on a 404', async () => {
    stubFetch(404, JSON.stringify({ detail: 'Not found' }));
    await expect(newService().getDisasterOverview(ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});

describe('USASpendingService federal-account POSTs', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The two breakdown dimensions differ only by a path segment, so the segment is
   * the whole contract of these methods — and the tool suite mocks the service
   * away, making this the only layer that can observe it.
   */
  it('getFederalAccountProgramActivities posts to the program_activities/total route', async () => {
    const fetchMock = stubFetch(200, JSON.stringify({ results: [], page_metadata: {} }));
    await newService().getFederalAccountProgramActivities('097-0100', { limit: 10, page: 1 }, ctx);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.usaspending.gov/api/v2/federal_accounts/097-0100/program_activities/total',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ limit: 10, page: 1 });
  });

  it('getFederalAccountObjectClasses posts to the object_classes/total route', async () => {
    const fetchMock = stubFetch(200, JSON.stringify({ results: [], page_metadata: {} }));
    await newService().getFederalAccountObjectClasses('097-0100', { limit: 10, page: 1 }, ctx);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.usaspending.gov/api/v2/federal_accounts/097-0100/object_classes/total',
    );
    expect(init.method).toBe('POST');
  });

  /**
   * A well-formed but nonexistent account code answers 200 with `total: 0` here,
   * unlike the sibling GET federal_accounts/{code}/, which 400s. The empty body
   * must reach the caller as data so the tool can disclose it as a notice — this
   * route must never be wired through getEntity(), which would flatten a real 4xx
   * into an indistinguishable `undefined`.
   */
  it('getFederalAccountProgramActivities returns the empty 200 body for a nonexistent account', async () => {
    stubFetch(
      200,
      JSON.stringify({
        results: [],
        page_metadata: { page: 1, total: 0, limit: 3, hasNext: false, hasPrevious: false },
      }),
    );
    const result = await newService().getFederalAccountProgramActivities(
      '999-9999',
      { limit: 3, page: 1 },
      ctx,
    );
    expect(result.results).toEqual([]);
    expect(result.page_metadata?.total).toBe(0);
  });

  it('getFederalAccountObjectClasses propagates a 404 rather than reporting an empty breakdown', async () => {
    // An account code that fails URL routing answers 404 with an HTML body.
    stubFetch(404, '<!doctype html><html><body><h1>Not Found</h1></body></html>');
    await expect(
      newService().getFederalAccountObjectClasses('garbage', { limit: 10, page: 1 }, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });
});

describe('USASpendingService getAwardFederalAccounts', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts award_id, limit, and page to awards/accounts/', async () => {
    const fetchMock = stubFetch(200, JSON.stringify({ results: [], page_metadata: {} }));
    await newService().getAwardFederalAccounts(
      { award_id: 'CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-', limit: 2, page: 1 },
      ctx,
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.usaspending.gov/api/v2/awards/accounts/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      award_id: 'CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-',
      limit: 2,
      page: 1,
    });
  });

  /**
   * A nonexistent award_id answers 200 with zero rows — the endpoint has no miss
   * status at all. The body must reach the caller as data (not `undefined`) so the
   * tool discloses it as a notice instead of a not-found that could never fire.
   */
  it('returns the empty 200 body for a nonexistent award_id', async () => {
    stubFetch(
      200,
      JSON.stringify({
        results: [],
        page_metadata: {
          page: 1,
          count: 0,
          next: null,
          previous: null,
          hasNext: false,
          hasPrevious: false,
        },
      }),
    );
    const result = await newService().getAwardFederalAccounts(
      { award_id: 'CONT_AWD_NOTAREALAWARD_0000_-NONE-_-NONE-', limit: 2, page: 1 },
      ctx,
    );
    expect(result.results).toEqual([]);
    expect(result.page_metadata?.count).toBe(0);
  });

  it('propagates the 422 an empty award_id draws', async () => {
    stubFetch(
      422,
      JSON.stringify({
        detail: "Invalid value in 'award_id'. '' is not a valid type (integer, text)",
      }),
    );
    await expect(
      newService().getAwardFederalAccounts({ award_id: '', limit: 2, page: 1 }, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });
});

describe('USASpendingService POST', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed body on 200', async () => {
    stubFetch(200, JSON.stringify({ group: 'fiscal_year', results: [] }));
    const result = await newService().spendingOverTime({ group: 'fiscal_year', filters: {} }, ctx);
    expect(result).toEqual({ group: 'fiscal_year', results: [] });
  });

  it('surfaces a non-2xx as the status-mapped error from fetchWithTimeout (#40)', async () => {
    // fetchWithTimeout owns non-2xx classification on the POST path too, which is why
    // the hand-rolled httpErrorFromResponse guard here was unreachable and removed.
    stubFetch(
      422,
      JSON.stringify({ detail: 'start_date falls before the earliest available search date' }),
    );
    await expect(
      newService().searchAwards(
        { filters: {}, fields: ['Award ID'], sort: 'Award Amount', limit: 1 },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { errorSource: 'FetchHttpError' },
    });
  });

  it('classifies an HTML error body rather than trying to parse it', async () => {
    stubFetch(403, '<!doctype html><html><body><h1>Forbidden</h1></body></html>');
    await expect(
      newService().spendingOverTime({ group: 'month', filters: {} }, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
  });
});
