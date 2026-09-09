import nock from 'nock';
import requireMetadataAccess from '../metadataAccess';
import getAuthHelperInstance from '../authHelper';
import headerParser from '../../utils/headerParser';
import getFilterObj from '../../es/filter';
import downloadRouter from '../../download';
import esInstance from '../../es/index';

jest.mock('../../config', () => ({
  arboristEndpoint: 'http://arborist-test',
  metadataAuthResource: '/mmrf_metadata',
  esConfig: { indices: [] },
  tierAccessLevel: 'private',
}));
jest.mock('../../es/index', () => ({
  getESIndexConfigByType: jest.fn(() => ({ index: 'case_centric' })),
  downloadData: jest.fn(async () => [{ case_id: 'test-case' }]),
}));
jest.mock('../../logger');

afterEach(() => { nock.cleanAll(); jest.clearAllMocks(); });

test('anonymous cannot use even a deliberately anonymous metadata policy', async () => {
  await expect(requireMetadataAccess(null)).rejects.toMatchObject({ code: 401 });
});

test('caller token and metadata-only action are sent to Arborist', async () => {
  const server = nock('http://arborist-test').post('/auth/request', {
    user: { token: 'browse-only-token' },
    requests: [{ resource: '/mmrf_metadata', action: { service: 'guppy', method: 'read' } }],
  }).reply(200, { auth: true });
  await expect(requireMetadataAccess('browse-only-token')).resolves.toBeUndefined();
  expect(server.isDone()).toBe(true);
});

test.each([
  [200, { auth: false }, 403], [200, { auth: 'true' }, 403],
  [401, {}, 401], [403, {}, 403], [500, {}, 503], [200, 'not-json', 503],
])('authorization failure does not become accessible metadata (%s)', async (status, body, expected) => {
  nock('http://arborist-test').post('/auth/request').reply(status, body);
  await expect(getAuthHelperInstance('invalid-or-expired')).rejects.toMatchObject({ code: expected });
});

test('private collection authorization preserves filters without nonexistent row ACL field', async () => {
  nock('http://arborist-test').post('/auth/request').reply(200, { auth: true });
  const helper = await getAuthHelperInstance('approved');
  const filter = { '=': { 'cgs_risk_key_criteria.cgs_risk_category': 'high risk' } };
  expect(helper.applyAccessibleFilter(filter)).toEqual(filter);
  expect(helper.getDefaultFilter('accessible')).toBeUndefined();
  expect(helper.applyUnaccessibleFilter()).toEqual({ IN: { _id: [] } });
  expect(getFilterObj({}, 'case_centric', helper.applyUnaccessibleFilter())).toEqual({ match_none: {} });
  expect(helper.getCanRefresh()).toBe(false);
});

test('cookie works, bearer wins, malformed header never falls back', () => {
  expect(headerParser.parseJWT({ headers: { cookie: 'access_token=cookie' } })).toBe('cookie');
  expect(headerParser.parseJWT({ headers: { authorization: 'Bearer header', cookie: 'access_token=cookie' } })).toBe('header');
  expect(headerParser.parseJWT({ headers: { authorization: 'Basic bad', cookie: 'access_token=cookie' } })).toBeNull();
});

test.each([null, 'denied', 'approved'])('download authorizes before accessing ES (%s)', async (token) => {
  if (token) nock('http://arborist-test').post('/auth/request').reply(200, { auth: token === 'approved' });
  const req = { body: { type: 'case_centric', fields: ['case_id'] }, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = { setHeader: jest.fn(), send: jest.fn() };
  const next = jest.fn();
  await downloadRouter(req, res, next);
  if (token === 'approved') {
    expect(next).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith([{ case_id: 'test-case' }]);
  } else {
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: token ? 403 : 401 }));
    expect(esInstance.downloadData).not.toHaveBeenCalled();
    expect(esInstance.getESIndexConfigByType).not.toHaveBeenCalled();
  }
});
