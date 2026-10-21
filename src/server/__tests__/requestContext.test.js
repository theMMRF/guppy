import http from 'http';
import express from 'express';
import { visibilityContext } from '../auth/fileVisibility';
import '../server';

jest.mock('express', () => {
  const actual = jest.requireActual('express');
  const factory = jest.fn(() => {
    const app = actual();
    // Exercise the real production middleware without starting ES/Apollo.
    app.listen = jest.fn();
    return app;
  });
  Object.assign(factory, actual);
  return { __esModule: true, default: factory };
});
jest.mock('../es/index', () => ({}));
jest.mock('../config', () => ({ esConfig: { indices: [] } }));
jest.mock('../logger');

let server;
beforeAll(async () => {
  const app = express.mock.results[0].value;
  app.post('/graphql', async (req, res) => {
    const scope = visibilityContext.getStore();
    if (!scope) return res.status(500).json({ error: 'Request context lost' });
    scope.resources = [req.body.resource];
    await new Promise((resolve) => setTimeout(resolve, 10));
    return res.json({ resources: visibilityContext.getStore().resources });
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const request = (resource, malformed = false) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port: server.address().port, path: '/graphql', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  // Headers and body arrive separately, so raw-body resumes on stream events.
  req.write('{"resource":');
  setTimeout(() => req.end(malformed ? 'invalid}' : `${JSON.stringify(resource)}}`), 10);
});

test('streamed concurrent JSON requests retain isolated production visibility contexts', async () => {
  const resources = ['/programs/MMRF/projects/one', '/programs/MMRF/projects/two'];
  const responses = await Promise.all(resources.map((resource) => request(resource)));
  responses.forEach((response, i) => {
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ resources: [resources[i]] });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  expect(visibilityContext.getStore()).toBeUndefined();
});

test('malformed streamed JSON retains no-store and does not reach the handler', async () => {
  const response = await request('ignored', true);
  expect(response.status).toBe(400);
  expect(response.headers['cache-control']).toBe('private, no-store');
});
