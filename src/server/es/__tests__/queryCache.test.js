import { QueryCache, stableStringify } from '../queryCache';

const makeCache = (options = {}) => {
  let currentTime = 1000;
  const logger = {
    debug: jest.fn(),
  };
  const cache = new QueryCache({
    ttlMs: 1000,
    maxSize: 10,
    now: () => currentTime,
    logger,
    ...options,
  });

  return {
    cache,
    logger,
    advance: (ms) => {
      currentTime += ms;
    },
  };
};

describe('ES query cache', () => {
  test('stableStringify canonicalizes object keys', () => {
    const first = stableStringify({
      queryBody: {
        query: { bool: { must: [{ terms: { 'project.project_id': ['MMRF-COMMPASS-IA24'] } }] } },
        _source: ['samples.submitter_id'],
        size: 10000,
      },
      esIndex: 'case_centric',
      esType: 'case_centric',
    });
    const second = stableStringify({
      esType: 'case_centric',
      esIndex: 'case_centric',
      queryBody: {
        size: 10000,
        _source: ['samples.submitter_id'],
        query: { bool: { must: [{ terms: { 'project.project_id': ['MMRF-COMMPASS-IA24'] } }] } },
      },
    });

    expect(first).toEqual(second);
  });

  test('dedupes concurrent identical calls into one fetch', async () => {
    const { cache } = makeCache();
    let resolveFetch;
    const fetcher = jest.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const request = {
      esIndex: 'case_centric',
      esType: 'case_centric',
      queryBody: {
        size: 10000,
        _source: ['samples.submitter_id'],
        query: { bool: { must: [{ terms: { 'project.project_id': ['MMRF-COMMPASS-IA24'] } }] } },
      },
    };

    const calls = Array.from({ length: 30 }, () => cache.run(request, fetcher));
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    const result = { hits: { hits: [{ _source: { samples: [{ submitter_id: 'sample-1' }] } }] } };
    resolveFetch(result);

    await expect(Promise.all(calls)).resolves.toEqual(Array(30).fill(result));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('does not dedupe different filters, fields, or auth scopes', async () => {
    const { cache } = makeCache();
    const fetcher = jest.fn((value) => Promise.resolve({ value }));
    const baseRequest = {
      esIndex: 'case_centric',
      esType: 'case_centric',
      queryBody: {
        size: 10000,
        _source: ['samples.submitter_id'],
        query: { term: { 'project.project_id': 'MMRF-COMMPASS-IA24' } },
      },
    };
    const differentField = {
      ...baseRequest,
      queryBody: { ...baseRequest.queryBody, _source: ['case_id'] },
    };
    const differentFilter = {
      ...baseRequest,
      queryBody: { ...baseRequest.queryBody, query: { term: { 'project.project_id': 'OTHER' } } },
    };
    const differentAuthScope = {
      ...baseRequest,
      queryBody: {
        ...baseRequest.queryBody,
        query: {
          bool: {
            must: [
              baseRequest.queryBody.query,
              { terms: { gen3_resource_path: ['programs/MMRF/projects/COMMPASS'] } },
            ],
          },
        },
      },
    };

    await Promise.all([
      cache.run(baseRequest, () => fetcher('base')),
      cache.run(differentField, () => fetcher('field')),
      cache.run(differentFilter, () => fetcher('filter')),
      cache.run(differentAuthScope, () => fetcher('auth')),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  test('serves successful results until TTL expiry', async () => {
    const { cache, advance } = makeCache();
    const request = {
      esIndex: 'case_centric',
      esType: 'case_centric',
      queryBody: { size: 10000, query: { match_all: {} } },
    };
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ value: 'first' })
      .mockResolvedValueOnce({ value: 'second' });

    await expect(cache.run(request, fetcher)).resolves.toEqual({ value: 'first' });
    await expect(cache.run(request, fetcher)).resolves.toEqual({ value: 'first' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    advance(1001);
    await expect(cache.run(request, fetcher)).resolves.toEqual({ value: 'second' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('can be disabled by TTL or max size', async () => {
    const request = {
      esIndex: 'case_centric',
      esType: 'case_centric',
      queryBody: { query: { match_all: {} } },
    };
    const ttlDisabled = new QueryCache({ ttlMs: 0, maxSize: 10 });
    const sizeDisabled = new QueryCache({ ttlMs: 1000, maxSize: 0 });
    const fetcher = jest.fn()
      .mockResolvedValueOnce('ttl-1')
      .mockResolvedValueOnce('ttl-2')
      .mockResolvedValueOnce('size-1')
      .mockResolvedValueOnce('size-2');

    await expect(ttlDisabled.run(request, fetcher)).resolves.toEqual('ttl-1');
    await expect(ttlDisabled.run(request, fetcher)).resolves.toEqual('ttl-2');
    await expect(sizeDisabled.run(request, fetcher)).resolves.toEqual('size-1');
    await expect(sizeDisabled.run(request, fetcher)).resolves.toEqual('size-2');

    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  test('removes failed in-flight calls and does not cache failures', async () => {
    const { cache } = makeCache();
    const request = {
      esIndex: 'case_centric',
      esType: 'case_centric',
      queryBody: { query: { match_all: {} } },
    };
    const fetcher = jest.fn()
      .mockRejectedValueOnce(new Error('ES queue rejected'))
      .mockResolvedValueOnce({ value: 'retry-ok' });

    await expect(cache.run(request, fetcher)).rejects.toThrow('ES queue rejected');
    await expect(cache.run(request, fetcher)).resolves.toEqual({ value: 'retry-ok' });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
