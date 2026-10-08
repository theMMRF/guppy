import { applyFileVisibility as applyPolicy, visibilityResources, visibilityContext, redactFileSource, redactFileResponse, protectedFilePaths } from '../fileVisibility';
import config from '../../config';

import { ElasticsearchFieldIndexer } from '../../es/fieldResolver';
const indexer = new ElasticsearchFieldIndexer({ _gen3_file_visibility_version: { type: 'integer' }, _gen3_file_authz: { type: 'keyword' }, files: { type: 'nested', properties: { _gen3_file_authz: { type: 'keyword' }, file_name: { type: 'keyword' } } } });
const applyFileVisibility = (body) => applyPolicy(body, indexer);

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
  expect(result.query.bool.filter[1].bool.filter[1].bool.should[1].bool.filter[1].script.script.params.allowed).toEqual({ [resource]: true });
  expect(body.query).toEqual({ term: { file_id: 'secret' } });
  expect(result.aggs).toEqual(body.aggs);
});

test('missing request context cannot grant restricted access', () => {
  const result = applyFileVisibility({});
  expect(result.query.bool.filter[1].bool.filter[1].bool.should[1].bool.filter[1].script.script.params.allowed).toEqual({});
});

test('concurrent users get distinct query and cache inputs', async () => {
  const bodies = await Promise.all([
    visibilityContext.run({ resources: [resource] }, async () => { await Promise.resolve(); return applyFileVisibility({}); }),
    visibilityContext.run({ resources: [] }, async () => { await Promise.resolve(); return applyFileVisibility({}); }),
  ]);
  expect(bodies[0]).not.toEqual(bodies[1]);
});

test('global facets retain their contract with filtered children and counts', () => {
  const result = applyFileVisibility({ aggs: { all: { global: {}, aggs: { names: { terms: { field: 'file_name' } } } } } });
  expect(result.aggs.all.global).toEqual({});
  expect(result.aggs.all.aggs.__gen3_visible_files.filter).toEqual(result.query.bool.filter[1]);
  expect(result.aggs.all.aggs.__gen3_visible_files.aggs.names).toEqual({ terms: { field: 'file_name' } });
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

test.each([0, '0', 0.5, '0.5', '0.99999999999999999', '9.9999999999999999e-1', '.99999999999999999', false, null, [], 'invalid'])('rejects unsafe term count %j in either nested alias', (value) => {
  expect(() => applyFileVisibility({ aggs: {}, aggregations: { outer: { aggs: { ids: { terms: { field: 'file_id', min_doc_count: value } } } } } })).toThrow();
});

test.each([1, '1', 1.5, '1.00000000000000001', '.1e1', '1.5'])('preserves safe positive term count %j', (value) => {
  expect(() => applyFileVisibility({ aggs: { ids: { terms: { field: 'file_id', min_doc_count: value } } } })).not.toThrow();
});


test('shared clinical case preserves its visible files and recomputes summaries', () => {
  const source = { case_id: 'case-1', diagnosis: 'myeloma', files: [
    { file_id: 'visible', file_name: 'rna.txt', _gen3_file_authz: [resource] },
    { file_id: 'secret', file_name: 'methylation.txt', _gen3_file_authz: ['/private/methylation'] },
  ], summary: { file_count: 2, file_size: 109, data_categories: [{ data_category: 'methylation', file_count: 1 }] }, _gen3_file_summary: [
    { authz: [resource], file_count: 1, file_size: 9, data_category: ['RNA'], experimental_strategy: ['RNA-Seq'], case_ids: ['case-1'] },
    { authz: ['/private/methylation'], file_count: 1, file_size: 100, data_category: ['methylation'], experimental_strategy: ['methylation'], case_ids: ['case-1'] },
  ] };
  const result = redactFileSource(source, [resource]);
  expect(result.case_id).toBe('case-1');
  expect(result.diagnosis).toBe('myeloma');
  expect(result.files).toEqual([{ file_id: 'visible', file_name: 'rna.txt' }]);
  expect(result.summary.file_count).toBe(1);
  expect(result.summary.file_size).toBe(9);
  expect(JSON.stringify(result)).not.toContain('methylation');
  expect(JSON.stringify(result)).not.toContain('_gen3_file_');
});

test('nested file query and facets enforce the same scopes', () => {
  const body = { query: { nested: { path: 'files', query: { term: { 'files.file_name': 'secret' } } } }, aggs: { files: { nested: { path: 'files' }, aggs: { names: { terms: { field: 'files.file_name' } } } } } };
  const result = visibilityContext.run({ resources: [resource] }, () => applyFileVisibility(body));
  expect(result.query.bool.filter[0].nested.query.bool.filter[1].bool.filter[1].script.script.params.field).toBe('files._gen3_file_authz');
  expect(result.aggs.files.aggs.__gen3_visible_files.filter.bool.filter[1].script.script.params.allowed).toEqual({ [resource]: true });
  const response = visibilityContext.run({ resources: [resource] }, () => redactFileResponse({ aggregations: { files: { doc_count: 2, __gen3_visible_files: { doc_count: 1, names: { buckets: [{ key: 'rna', doc_count: 1 }] } } } } }));
  expect(response.aggregations.files.doc_count).toBe(1);
  expect(response.aggregations.files.names.buckets).toEqual([{ key: 'rna', doc_count: 1 }]);
});

test('unsupported precomputed file counters cannot be probed', () => {
  expect(() => applyFileVisibility({ aggs: { count: { sum: { field: 'summary.file_count' } } } })).toThrow();
  expect(() => applyFileVisibility({ query: { range: { 'summary.file_count': { gt: 0 } } } })).toThrow();
  expect(() => applyFileVisibility({ _source: ['summary.file_count'] })).not.toThrow();
});

test('ownership mapping rejects parent copy_to and object arrays', () => {
  expect(() => protectedFilePaths(new ElasticsearchFieldIndexer({ _gen3_file_visibility_version: { type: 'integer' }, _gen3_file_authz: { type: 'keyword' }, files: { type: 'object', properties: { _gen3_file_authz: { type: 'keyword' } } } }))).toThrow();
  expect(() => protectedFilePaths(new ElasticsearchFieldIndexer({ _gen3_file_visibility_version: { type: 'integer' }, _gen3_file_authz: { type: 'keyword' }, files: { type: 'nested', properties: { file_name: { type: 'text', copy_to: 'all_text' }, _gen3_file_authz: { type: 'keyword' } } } }))).toThrow();
});


test('aggregation order arrays cannot rank buckets by private nested counts', () => {
  expect(() => applyFileVisibility({ aggs: { cases: { terms: { field: 'case_id', order: [{ 'files>_count': 'desc' }] } } } })).toThrow();
  expect(() => applyFileVisibility({ aggs: { cases: { terms: { field: 'case_id', order: [{ _count: 'desc' }, { _key: 'asc' }] } } } })).not.toThrow();
});
