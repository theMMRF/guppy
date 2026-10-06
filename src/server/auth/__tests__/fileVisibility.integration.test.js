// Uses only a disposable ES cluster when explicitly configured.
import config from '../../config';
import { visibilityContext } from '../fileVisibility';

const url = process.env.VISIBILITY_TEST_ES_URL;
const integration = url ? describe : describe.skip;
const a = '/programs/MMRF/projects/private-a';
const b = '/programs/MMRF/projects/private-b';

integration('file visibility on Elasticsearch 7', () => {
  let es;
  const index = `visibility-guppy-${Date.now()}`;
  beforeAll(async () => {
    config.esConfig.host = url;
    config.fileVisibilityEnabled = true;
    es = require('../../es').default; // eslint-disable-line global-require
    await es.client.indices.create({
      index,
      body: {
        mappings: {
          properties: {
            file_id: { type: 'keyword' },
            category: { type: 'keyword' },
            _gen3_visibility: { type: 'keyword' },
            _gen3_visibility_authz: { type: 'keyword' },
          },
        },
      },
    });
    const docs = [
      { file_id: 'legacy', category: 'public' },
      { file_id: 'public', category: 'public', _gen3_visibility: 'public' },
      {
        file_id: 'private-a', category: 'secret', _gen3_visibility: 'restricted', _gen3_visibility_authz: [a],
      },
      {
        file_id: 'private-ab', category: 'secret', _gen3_visibility: 'restricted', _gen3_visibility_authz: [a, b],
      },
      { file_id: 'invalid', category: 'secret', _gen3_visibility: 'restricted' },
    ];
    await es.client.bulk({ refresh: true, body: docs.flatMap((doc) => [{ index: { _index: index } }, doc]) });
    jest.spyOn(es, 'getESFields').mockReturnValue({ fields: [{ name: 'file_id' }] });
  });
  afterAll(async () => {
    if (es) {
      await es.client.indices.delete({ index });
      await es.client.close();
    }
    config.fileVisibilityEnabled = false;
    jest.restoreAllMocks();
  });

  test.each([[[], 1], [[a], 2], [[a, b], 3]])('filters hits, facets and scroll for %j', async (resources, expected) => {
    await visibilityContext.run({ resources }, async () => {
      const result = await es.query(index, 'files', { _source: ['file_id'], aggs: { categories: { terms: { field: 'category' } } } });
      expect(result.hits.total.value).toBe(expected);
      expect(result.aggregations.categories.buckets.reduce((sum, bucket) => sum + bucket.doc_count, 0)).toBe(expected);
      const documents = await es.scrollQuery(index, 'files', { fields: ['file_id'] });
      expect(documents).toHaveLength(expected);
      expect(documents.every((doc) => Object.keys(doc).join() === 'file_id')).toBe(true);
    });
  });

  test('concurrent cache entries preserve each caller policy', async () => {
    const query = () => es.query(index, 'files', { size: 0 });
    const responses = await Promise.all([
      visibilityContext.run({ resources: [a, b] }, query),
      visibilityContext.run({ resources: [] }, query),
    ]);
    expect(responses.map((response) => response.hits.total.value)).toEqual([3, 1]);
  });
  test('large permission maps and facets never reveal hidden identifiers', async () => {
    const resources = Array.from({ length: 1100 }, (_, i) => `/large/${i}`).concat(a);
    await visibilityContext.run({ resources }, async () => {
      const result = await es.query(index, 'files', { aggs: { ids: { terms: { field: 'file_id' } } } });
      expect(result.hits.hits.map((hit) => hit._source.file_id).sort()).toEqual(['private-a', 'public']);
      expect(result.aggregations.ids.buckets.map((bucket) => bucket.key).sort()).toEqual(['private-a', 'public']);
      await Promise.all([0, '0', 0.5].map(async (value) => {
        await expect(es.query(index, 'files', {
          aggs: { ids: { terms: { field: 'file_id', min_doc_count: value } } },
        })).rejects.toThrow();
      }));
    });
  });
});
