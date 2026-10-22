import nock from 'nock'; // eslint-disable-line no-unused-vars
import { validateSchema } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { buildSchemaString } from '../schema';
import getResolver from '../resolvers';
import esInstance from '../es';
import config from '../config';
import setupMockDataEndpoint from '../__mocks__/mockDataFromES';

jest.mock('../config');
jest.mock('../logger');

setupMockDataEndpoint();

describe('startup with prepared file-visibility mappings', () => {
  afterEach(() => {
    config.fileVisibilityEnabled = false;
    delete esInstance.config.arrayConfig;
    jest.restoreAllMocks();
  });

  test.each([false, true])('builds public schema with enforcement enabled=%s', async (enabled) => {
    const mappings = {};
    await Promise.all(config.esConfig.indices.map(async ({ index }) => {
      const mapping = await esInstance._getESFieldsTypes(index);
      mappings[index] = {
        ...mapping,
        _gen3_file_authz: { type: 'keyword' },
        _gen3_file_visibility_version: { type: 'integer' },
        _gen3_file_summary: { type: 'object', enabled: false },
        files: {
          type: 'nested',
          properties: {
            file_id: { type: 'keyword' },
            file_name: { type: 'keyword' },
            _gen3_file_authz: { type: 'keyword' },
            metadata_files: {
              type: 'nested',
              properties: {
                file_name: { type: 'keyword' },
                _gen3_file_authz: { type: 'keyword' },
                _gen3_file_summary: { type: 'object', enabled: false },
              },
            },
          },
        },
      };
    }));
    const original = JSON.stringify(mappings);
    jest.spyOn(esInstance, '_getESFieldsTypes').mockImplementation(async (index) => mappings[index]);
    config.fileVisibilityEnabled = enabled;
    esInstance.config.arrayConfig = [];

    await esInstance.initialize();
    config.esConfig.indices.forEach((cfg) => {
      const indexConfig = { ...config.esConfig, indices: [cfg] };
      const schemaString = buildSchemaString(indexConfig, esInstance);
      const schema = makeExecutableSchema({
        typeDefs: schemaString,
        resolvers: getResolver(indexConfig, esInstance),
      });
      expect(validateSchema(schema)).toEqual([]);
      expect(schemaString).toContain('file_name: String');
      expect(schemaString).not.toContain('_gen3_file_');
    });
    expect(JSON.stringify(esInstance.getESFields())).not.toContain('_gen3_file_');

    config.esConfig.indices.forEach(({ index }) => {
      expect(esInstance.paths[index].fieldIndex.has('_gen3_file_authz')).toBe(true);
      expect(esInstance.paths[index].fieldIndex.has('_gen3_file_visibility_version')).toBe(true);
      expect(esInstance.paths[index].fieldIndex.has('files.metadata_files._gen3_file_authz')).toBe(true);
    });
    expect(JSON.stringify(mappings)).toBe(original);
  });
});
