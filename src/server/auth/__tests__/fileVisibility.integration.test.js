import config from '../../config';
import { visibilityContext } from '../fileVisibility';
import { ElasticsearchFieldIndexer } from '../../es/fieldResolver';

const url = process.env.VISIBILITY_TEST_ES_URL;
const integration = url ? describe : describe.skip;
const a = '/programs/MMRF/projects/private-a';
const b = '/programs/MMRF/projects/private-b';
const open = '/open';
const policyProperties = { _gen3_file_visibility_version: { type: 'integer' }, _gen3_file_authz: { type: 'keyword' }, _gen3_file_summary: { type: 'object', enabled: false } };

integration('project-owned file visibility on real Elasticsearch 7', () => {
  let es;
  const index = `project-visibility-files-${Date.now()}`;
  const cases = `${index}-cases`;
  beforeAll(async () => {
    config.esConfig.host = url;
    config.fileVisibilityEnabled = true;
    es = require('../../es').default; // eslint-disable-line global-require
    const properties = { ...policyProperties, file_id: { type: 'keyword' }, category: { type: 'keyword' } };
    const caseProperties = { ...policyProperties, case_id: { type: 'keyword' }, diagnosis: { type: 'keyword' }, files: { type: 'nested', properties: { file_id: { type: 'keyword' }, file_name: { type: 'keyword' }, _gen3_file_authz: { type: 'keyword' } } }, summary: { properties: { file_count: { type: 'long' }, file_size: { type: 'long' } } } };
    await es.client.indices.create({ index, body: { mappings: { properties } } });
    await es.client.indices.create({ index: cases, body: { mappings: { properties: caseProperties } } });
    es.paths = { [index]: new ElasticsearchFieldIndexer(properties), [cases]: new ElasticsearchFieldIndexer(caseProperties) };
    const docs = [
      { file_id: 'legacy', category: 'public' },
      { file_id: 'public', category: 'public', _gen3_file_visibility_version: 1, _gen3_file_authz: [open] },
      { file_id: 'private-a', category: 'secret', _gen3_file_visibility_version: 1, _gen3_file_authz: [a] },
      { file_id: 'private-ab', category: 'secret', _gen3_file_visibility_version: 1, _gen3_file_authz: [a, b] },
      { file_id: 'invalid', category: 'secret', _gen3_file_visibility_version: 1 },
    ];
    await es.client.bulk({ refresh: true, body: docs.flatMap((doc) => [{ index: { _index: index } }, doc]) });
    await es.client.index({ index: cases, id: 'case-1', refresh: true, body: {
      case_id: 'case-1', diagnosis: 'myeloma', _gen3_file_visibility_version: 1,
      unrequested_payload: 'x'.repeat(1024 * 1024),
      files: [{ file_id: 'public', file_name: 'rna.txt', _gen3_file_authz: [open] }, { file_id: 'secret', file_name: 'methylation.txt', _gen3_file_authz: [a] }],
      summary: { file_count: 2, file_size: 109 },
      _gen3_file_summary: [{ authz: [open], file_count: 1, file_size: 9, data_category: ['RNA'], experimental_strategy: [], case_ids: ['case-1'] }, { authz: [a], file_count: 1, file_size: 100, data_category: ['methylation'], experimental_strategy: [], case_ids: ['case-1'] }],
    } });
    jest.spyOn(es, 'getESFields').mockReturnValue({ fields: [{ name: 'file_id' }] });
  });
  afterAll(async () => {
    if (es) {
      await es.client.indices.delete({ index: [index, cases] });
      await es.client.close();
    }
    config.fileVisibilityEnabled = false;
    jest.restoreAllMocks();
  });
  test.each([[[], 0], [[open], 1], [[open, a], 2], [[open, a, b], 3]])('filters hits, facets and exports for %j', async (resources, expected) => {
    await visibilityContext.run({ resources }, async () => {
      const result = await es.query(index, 'file', { aggs: { ids: { terms: { field: 'file_id' } } } });
      expect(result.hits.total.value).toBe(expected);
      expect(result.aggregations.ids.buckets.reduce((sum, bucket) => sum + bucket.doc_count, 0)).toBe(expected);
      const documents = await es.scrollQuery(index, 'file', { fields: ['file_id'] });
      expect(documents).toHaveLength(expected);
      expect(documents.every((doc) => Object.keys(doc).join() === 'file_id')).toBe(true);
    });
  });
  test('shared case remains visible without exposing private file metadata or totals', async () => {
    await visibilityContext.run({ resources: [open] }, async () => {
      const result = await es.query(cases, 'case', { _source: ['case_id', 'diagnosis', 'files.file_name', 'summary.file_count', 'summary.file_size'] });
      expect(result.hits.total.value).toBe(1);
      expect(result.hits.hits[0]._source).toEqual({ case_id: 'case-1', diagnosis: 'myeloma', files: [{ file_name: 'rna.txt' }], summary: { file_count: 1, file_size: 9 } });
      expect(JSON.stringify(result)).not.toContain('methylation');
      expect(JSON.stringify(result)).not.toContain('_gen3_file_');
    });
  });
  test('clinical searches, top-level counts and exports keep the ES response bounded', async () => {
    const search = jest.spyOn(es.client, 'search');
    try {
      await visibilityContext.run({ resources: [open] }, async () => {
        const result = await es.query(cases, 'case', { size: 10000, _source: ['case_id', 'diagnosis'] });
        expect(result.hits.hits[0]._source).toEqual({ case_id: 'case-1', diagnosis: 'myeloma' });
        const raw = (await search.mock.results[search.mock.results.length - 1].value).body;
        expect(JSON.stringify(raw).length).toBeLessThan(2048);
        expect(search.mock.calls[search.mock.calls.length - 1][0].body._source).toEqual(['case_id', 'diagnosis', '_gen3_file_authz']);
        await es.query(cases, 'case', { size: 1, _source: false });
        expect((await search.mock.results[search.mock.results.length - 1].value).body.hits.hits[0]._source).toBeUndefined();
        es.getESFields.mockReturnValueOnce({ fields: [{ name: 'case_id' }, { name: 'diagnosis' }] });
        expect(await es.scrollQuery(cases, 'case', { fields: ['case_id', 'diagnosis'] })).toEqual([{ case_id: 'case-1', diagnosis: 'myeloma' }]);
        const request = search.mock.calls[search.mock.calls.length - 1][0];
        expect(request.body._source).toEqual(['case_id', 'diagnosis', '_gen3_file_authz']);
        expect(request._source).toBeUndefined();
        expect(JSON.stringify((await search.mock.results[search.mock.results.length - 1].value).body).length).toBeLessThan(2048);
      });
    } finally {
      search.mockRestore();
    }
  });
  test('source exclusions and wildcards cannot strip correlated ownership before redaction', async () => {
    await visibilityContext.run({ resources: [open] }, async () => {
      const result = await es.query(cases, 'case', { _source: { includes: ['fi*.file_name', 'summary.file_count'], excludes: ['*_gen3_file_authz'] } });
      expect(result.hits.hits[0]._source).toEqual({ files: [{ file_name: 'rna.txt' }], summary: { file_count: 1 } });
      expect(JSON.stringify(result)).not.toContain('methylation');
    });
  });
  test('hidden embedded files cannot match filters, facets, counts or top hits', async () => {
    await visibilityContext.run({ resources: [open] }, async () => {
      const query = { nested: { path: 'files', query: { term: { 'files.file_name': 'methylation.txt' } } } };
      expect((await es.query(cases, 'case', { query })).hits.total.value).toBe(0);
      const result = await es.query(cases, 'case', { size: 0, aggs: { files: { nested: { path: 'files' }, aggs: { names: { terms: { field: 'files.file_name' } }, examples: { top_hits: { size: 10, _source: ['files.file_name'] } } } } } });
      expect(result.aggregations.files.doc_count).toBe(1);
      expect(result.aggregations.files.names.buckets).toEqual([{ key: 'rna.txt', doc_count: 1 }]);
      expect(JSON.stringify(result)).not.toContain('methylation');
    });
  });
  test('global facets ignore user query but never visibility', async () => {
    await visibilityContext.run({ resources: [open] }, async () => {
      const result = await es.query(index, 'file', { query: { match_none: {} }, aggs: { all: { global: {}, aggs: { ids: { terms: { field: 'file_id' } } } } } });
      expect(result.hits.total.value).toBe(0);
      expect(result.aggregations.all.doc_count).toBe(1);
      expect(result.aggregations.all.ids.buckets).toEqual([{ key: 'public', doc_count: 1 }]);
      const mixed = await es.query(cases, 'case', { aggs: { probe: { filter: { nested: { path: 'files', query: { term: { 'files.file_name': 'methylation.txt' } } } } } } });
      expect(mixed.aggregations.probe.doc_count).toBe(0);
    });
  });
  test('concurrent caches and later source projections preserve each caller policy', async () => {
    const query = () => es.query(index, 'file', { size: 0 });
    const responses = await Promise.all([visibilityContext.run({ resources: [open, a, b] }, query), visibilityContext.run({ resources: [] }, query)]);
    expect(responses.map((response) => response.hits.total.value)).toEqual([3, 0]);
    await visibilityContext.run({ resources: [open] }, async () => {
      const narrow = await es.query(cases, 'case', { _source: ['case_id'] });
      const wide = await es.query(cases, 'case', { _source: ['files.file_name'] });
      expect(narrow.hits.hits[0]._source).toEqual({ case_id: 'case-1' });
      expect(wide.hits.hits[0]._source).toEqual({ files: [{ file_name: 'rna.txt' }] });
    });
  });
  test('large permission sets retain all-owner semantics', async () => {
    const resources = Array.from({ length: 1100 }, (_, i) => `/large/${i}`).concat(open, a);
    await visibilityContext.run({ resources }, async () => {
      const result = await es.query(index, 'file', { aggs: { ids: { terms: { field: 'file_id' } } } });
      expect(result.hits.hits.map((hit) => hit._source.file_id).sort()).toEqual(['private-a', 'public']);
      await Promise.all([0, '0', 0.5, '0.99999999999999999', '9.9999999999999999e-1'].map(async (value) => {
        await expect(es.query(index, 'file', { aggs: { ids: { terms: { field: 'file_id', min_doc_count: value } } } })).rejects.toThrow();
      }));
    });
  });
});
