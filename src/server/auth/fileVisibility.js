import { AsyncLocalStorage } from 'async_hooks';
import config from '../config';
import CodedError from '../utils/error';

// Permissions and query cache keys belong to a request, never to the ES singleton.
export const visibilityContext = new AsyncLocalStorage();

export const downloadableResources = (mapping) => {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new CodedError(503, 'Invalid authorization mapping');
  }
  return Object.keys(mapping).filter((resource) => {
    const actions = mapping[resource];
    if (!Array.isArray(actions)) throw new CodedError(503, 'Invalid authorization mapping');
    return actions.some((action) => action && typeof action === 'object' && ['fence', '*'].includes(action.service)
      && ['read-storage', '*'].includes(action.method));
  }).sort();
};

export const visibilityQuery = (resources = []) => {
  const visibility = '_gen3_visibility';
  const authz = '_gen3_visibility_authz';
  const allowed = [
    { term: { [visibility]: 'public' } },
  ];
  if (resources.length) {
    allowed.push({
      bool: {
        filter: [
          { term: { [visibility]: 'restricted' } },
          { exists: { field: authz } },
          {
            terms_set: {
              [authz]: {
                terms: [...new Set(resources)].sort(),
                minimum_should_match_script: {
                  source: 'doc[params.field].size()',
                  params: { field: authz },
                },
              },
            },
          },
        ],
      },
    });
  }
  return { bool: { should: allowed, minimum_should_match: 1 } };
};

const hasGlobalAggregation = (aggregations) => Object.values(aggregations || {}).some(
  (aggregation) => ['global', 'significant_terms', 'significant_text'].some((key) => Object.prototype.hasOwnProperty.call(aggregation, key))
    || hasGlobalAggregation(aggregation.aggs || aggregation.aggregations),
);

export const applyFileVisibility = (body) => {
  if (!config.fileVisibilityEnabled) return body;
  if (body.suggest || ['_gen3_visibility', '_gen3_visibility_authz'].some((field) => Object.prototype.hasOwnProperty.call(body.runtime_mappings || {}, field))) {
    throw new CodedError(400, 'Query cannot override or bypass file visibility');
  }
  if (hasGlobalAggregation(body.aggs || body.aggregations)) {
    throw new CodedError(400, 'Aggregations cannot bypass file visibility');
  }
  const scope = visibilityContext.getStore();
  const resources = (scope && scope.resources) || [];
  return {
    ...body,
    query: { bool: { filter: [body.query || { match_all: {} }, visibilityQuery(resources)] } },
  };
};
