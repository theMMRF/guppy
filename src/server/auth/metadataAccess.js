import fetch from 'node-fetch';
import config from '../config';
import CodedError from '../utils/error';

// A deployment may authorize its entire metadata collection as one resource.
// This is for indices shared by all approved users which lack row-level ACLs.
// It never grants access merely because a token is present.
export default async function requireMetadataAccess(jwt) {
  if (!jwt) throw new CodedError(401, 'An access token is required');
  let response;
  try {
    response = await fetch(`${config.arboristEndpoint}/auth/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: { token: jwt },
        requests: [{
          resource: config.metadataAuthResource,
          action: { service: 'guppy', method: 'read' },
        }],
      }),
      timeout: 10000,
    });
  } catch (err) {
    throw new CodedError(503, 'Authorization service unavailable');
  }
  if (response.status === 401 || response.status === 403) {
    throw new CodedError(response.status, 'Metadata access denied');
  }
  if (!response.ok) throw new CodedError(503, 'Authorization service unavailable');
  let result;
  try {
    result = await response.json();
  } catch (err) {
    throw new CodedError(503, 'Authorization service unavailable');
  }
  if (result.auth !== true) throw new CodedError(403, 'Metadata access denied');
}
