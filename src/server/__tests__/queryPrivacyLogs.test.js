import es from '../es';
import config from '../config';
import log from '../logger';
import { visibilityContext } from '../auth/fileVisibility';
import { ElasticsearchFieldIndexer } from '../es/fieldResolver';

jest.mock('../config');
jest.mock('../logger', () => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn() }));
jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn(() => ({ ping: jest.fn(), search: jest.fn(), clearScroll: jest.fn() })),
}));

test('search, scroll and cache logs omit server-added authorization resources', async () => {
  const resource = '/programs/MMRF/projects/private-logging-test';
  const indexer = new ElasticsearchFieldIndexer({
    _gen3_file_authz: { type: 'keyword' },
    _gen3_file_visibility_version: { type: 'integer' },
  });
  config.fileVisibilityEnabled = true;
  const layout = jest.spyOn(es, '_visibilityLayout').mockResolvedValue({ indices: 'test', indexer });
  const fields = jest.spyOn(es, 'getESFields').mockReturnValue({ fields: [] });
  es.client.search.mockResolvedValue({ body: { _scroll_id: 'scroll-test', hits: { hits: [] } } });
  es.client.clearScroll.mockResolvedValue({});
  es.queryCache.clear();
  jest.clearAllMocks();
  try {
    await visibilityContext.run({ resources: [resource] }, async () => {
      await es.query('test', 'test', { size: 0 });
      await es.query('test', 'test', { size: 0 });
      await es.scrollQuery('test', 'test', { fields: [] });
    });
    expect(es.client.search).toHaveBeenCalledTimes(2);
    es.client.search.mock.calls.forEach(([request]) => {
      expect(JSON.stringify(request.body)).toContain(resource);
    });
    expect(log.info).toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
    const messages = JSON.stringify([...log.info.mock.calls, ...log.debug.mock.calls]);
    expect(messages).not.toContain(resource);
    expect(messages).not.toContain('params');
    expect(messages).toContain('[ES.queryCache] hit');
  } finally {
    config.fileVisibilityEnabled = false;
    layout.mockRestore();
    fields.mockRestore();
    es.queryCache.clear();
  }
});
