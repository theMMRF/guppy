import { applyFileVisibility, visibilityResources, visibilityContext } from '../fileVisibility';
import config from '../../config';

const resource = '/programs/MMRF/projects/private';
beforeEach(() => { config.fileVisibilityEnabled = true; });
afterEach(() => { config.fileVisibilityEnabled = false; });

test('uses independent IndexD metadata actions including wildcards', () => {
  expect(visibilityResources({
    [resource]: [{ service: 'indexd', method: 'read-metadata' }],
    download: [{ service: 'fence', method: 'read-storage' }],
    metadata: [{ service: 'guppy', method: 'read' }],
    wrong: [{ service: 'fence', method: 'not-read-storage' }],
    wildcard: [{ service: '*', method: '*' }],
  })).toEqual([resource, 'wildcard']);
  expect(() => visibilityResources({ error: {} })).toThrow();
});

test('policy wraps query before cache, projections and aggregation', () => {
  const body = { query: { term: { file_id: 'secret' } }, _source: ['file_name'], aggs: { total: { value_count: { field: 'file_id' } } } };
  const result = visibilityContext.run({ resources: [resource] }, () => applyFileVisibility(body));
  expect(result.query.bool.filter[0]).toEqual(body.query);
  expect(result.query.bool.filter[1].bool.should[1].bool.filter[2].script.script.params.allowed).toEqual({ [resource]: true });
  expect(body.query).toEqual({ term: { file_id: 'secret' } });
  expect(result.aggs).toEqual(body.aggs);
});

test('missing request context cannot grant restricted access', () => {
  const result = applyFileVisibility({});
  expect(result.query.bool.filter[1].bool.should).toHaveLength(1);
});

test('concurrent users get distinct query and cache inputs', async () => {
  const bodies = await Promise.all([
    visibilityContext.run({ resources: [resource] }, async () => { await Promise.resolve(); return applyFileVisibility({}); }),
    visibilityContext.run({ resources: [] }, async () => { await Promise.resolve(); return applyFileVisibility({}); }),
  ]);
  expect(bodies[0]).not.toEqual(bodies[1]);
});

test('global aggregations cannot ignore the policy', () => {
  expect(() => applyFileVisibility({ aggs: { nested: { aggs: { all: { global: {} } } } } })).toThrow();
});

test('disabled mode preserves current queries', () => {
  config.fileVisibilityEnabled = false;
  const body = { query: { match_all: {} } };
  expect(applyFileVisibility(body)).toBe(body);
});

test.each([
  { suggest: { names: { term: { field: 'file_name' } } } },
  { runtime_mappings: { _gen3_visibility: { type: 'keyword', script: "emit('public')" } } },
  { aggs: { names: { significant_terms: { field: 'file_name' } } } },
])('rejects query features with unfiltered background data', (body) => {
  expect(() => applyFileVisibility(body)).toThrow();
});


test.each([
  { aggs: {}, aggregations: { leaked: { global: {} } } },
  { aggs: { outer: { aggregations: { leaked: { global: {} } }, aggs: {} } } },
  { aggs: { identifiers: { terms: { field: 'file_id', min_doc_count: 0 } } } },
  { aggs: { outer: { aggs: { identifiers: { terms: { field: 'file_id', min_doc_count: 0 } } } } } },
])('rejects both aggregation aliases and zero-count term buckets', (body) => {
  expect(() => applyFileVisibility(body)).toThrow();
});
