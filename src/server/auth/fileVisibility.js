import { AsyncLocalStorage } from 'async_hooks';
import config from '../config';
import CodedError from '../utils/error';

// Permissions and query cache keys belong to a request, never to the ES singleton.
export const visibilityContext = new AsyncLocalStorage();

export const visibilityResources = (mapping) => {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new CodedError(503, 'Invalid authorization mapping');
  }
  return Object.keys(mapping).filter((resource) => {
    const actions = mapping[resource];
    if (!Array.isArray(actions)) throw new CodedError(503, 'Invalid authorization mapping');
    return actions.some((action) => action && typeof action === 'object' && ['indexd', '*'].includes(action.service)
      && ['read-metadata', '*'].includes(action.method));
  }).sort();
};

// ES coerces fractional values to long and accepts string numbers. Values below
// one can expose unfiltered dictionary terms as zero-count buckets.
// Compare a decimal string's first nonzero digit position without float rounding.
const decimalStringAtLeastOne = (value) => {
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!match) return false;
  const integer = match[1] || '';
  const digits = `${integer}${match[2] || match[3] || ''}`;
  const first = digits.search(/[1-9]/);
  const exponent = Number(match[4] || 0);
  return first >= 0 && Number.isSafeInteger(exponent) && integer.length - first + exponent > 0;
};

const unsafeTermsCount = (aggregation) => {
  const { terms } = aggregation;
  if (!terms || !Object.prototype.hasOwnProperty.call(terms, 'min_doc_count')) return false;
  const value = terms.min_doc_count;
  return !['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 1
    || (typeof value === 'string' && !decimalStringAtLeastOne(value));
};

const hasGlobalAggregation = (aggregations) => Object.values(aggregations || {}).some(
  (aggregation) => ['significant_terms', 'significant_text'].some((key) => Object.prototype.hasOwnProperty.call(aggregation, key))
    || unsafeTermsCount(aggregation)
    || hasGlobalAggregation(aggregation.aggs) || hasGlobalAggregation(aggregation.aggregations),
);

// Ownership is prepared once from IndexD; grants always come from usersync/Arborist.
export const FILE_AUTHZ = '_gen3_file_authz';
export const FILE_VERSION = '_gen3_file_visibility_version';
const VISIBLE_AGG = '__gen3_visible_files';
const fileSummaryKeys = ['file_count', 'file_size', 'data_categories', 'experimental_strategies'];

export const ownershipQuery = (resources, field = FILE_AUTHZ) => ({
  bool: { filter: [
    { exists: { field } },
    { script: { script: {
      source: 'def required = doc[params.field]; if (required.size() == 0) return false; for (def resource : required) { if (!params.allowed.containsKey(resource)) return false; } return true;',
      params: { field, allowed: Object.fromEntries([...new Set(resources)].sort().map((r) => [r, true])) },
    } } },
  ] },
});

export const visibilityQuery = (resources = []) => ({ bool: { filter: [
  { term: { [FILE_VERSION]: 1 } },
  { bool: { should: [
    { bool: { must_not: [FILE_AUTHZ, 'file_id', 'object_id', 'did', 'file_name'].map((field) => ({ exists: { field } })) } },
    ownershipQuery(resources),
  ], minimum_should_match: 1 } },
] } });

// All file containers must be nested: an object array loses ownership/field correlation.
export const protectedFilePaths = (indexer) => {
  if (!indexer || !indexer.fieldIndex.has(FILE_VERSION) || !indexer.fieldIndex.has(FILE_AUTHZ)) {
    throw new CodedError(503, 'Search projection has not been prepared for project visibility');
  }
  const paths = new Map();
  indexer.fieldIndex.forEach((info, field) => {
    if (field === FILE_AUTHZ || field.endsWith(`.${FILE_AUTHZ}`)) {
      if (info.type !== 'keyword' || info.fieldDef.doc_values === false) {
        throw new CodedError(503, 'File ownership requires keyword doc values');
      }
      if (field !== FILE_AUTHZ) {
        const path = field.slice(0, -FILE_AUTHZ.length - 1);
        const definition = indexer.fieldIndex.get(path)?.fieldDef;
        if (!indexer.fieldIndex.get(path)?.isNested || definition.include_in_parent || definition.include_in_root) {
          throw new CodedError(503, 'File ownership containers must be nested');
        }
        paths.set(path, field);
      }
    }
  });
  indexer.fieldIndex.forEach((info, field) => {
    const owner = [...paths.keys()].find((path) => field.startsWith(`${path}.`));
    if (owner && info.fieldDef.copy_to) {
      const copies = [].concat(info.fieldDef.copy_to);
      if (copies.some((target) => !target.startsWith(`${owner}.`))) {
        throw new CodedError(503, 'File fields cannot copy into an unfiltered parent');
      }
    }
  });
  return paths;
};

const checkQuery = (value, paths, key = '') => {
  if (!value || typeof value !== 'object') return;
  if (value.aggs && value.aggregations) throw new CodedError(400, 'Use one aggregation alias');
  Object.entries(value).forEach(([name, item]) => {
    if (['_source', 'includes', 'excludes'].includes(name)) return;
    if (['script', 'script_fields', 'runtime_mappings', 'suggest', 'highlight', 'fields', 'docvalue_fields', 'stored_fields', 'query_string', 'simple_query_string', 'buckets_path', 'has_child', 'has_parent', 'parent_id', 'profile', 'explain'].includes(name)) {
      throw new CodedError(400, 'Query cannot bypass project visibility');
    }
    if (name === VISIBLE_AGG || /(?:^|\.)summary\.(?:file_count|file_size|data_categories|experimental_strategies)(?:\.|$)/.test(name)
      || ((name === 'field' || key === 'sort') && typeof item === 'string' && /(?:^|\.)summary\.(?:file_count|file_size|data_categories|experimental_strategies)(?:\.|$)/.test(item))) {
      throw new CodedError(400, 'Query file summaries through the filtered file index');
    }
    if (name === 'order' && item && typeof item === 'object' && (Array.isArray(item) ? item : [item]).some((order) => !order || typeof order !== 'object' || Array.isArray(order) || Object.keys(order).some((field) => !['_key', '_count'].includes(field)))) throw new CodedError(400, 'Custom aggregation ordering can expose unfiltered file counts');
    if (name === 'terms' && item && typeof item === 'object' && Object.values(item).some((option) => option && typeof option === 'object' && !Array.isArray(option) && 'index' in option)) throw new CodedError(400, 'Terms lookup cannot bypass project visibility');
    checkQuery(item, paths, name);
  });
};

const filtered = (query, guard) => ({ bool: { filter: [query || { match_all: {} }, guard] } });
const rewriteQuery = (value, paths, resources) => {
  if (Array.isArray(value)) return value.map((item) => rewriteQuery(item, paths, resources));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteQuery(item, paths, resources)]));
  if (result.nested?.query && paths.has(result.nested.path)) {
    result.nested.query = filtered(result.nested.query, ownershipQuery(resources, paths.get(result.nested.path)));
  }
  return result;
};
const rewriteAggregations = (aggregations, paths, resources) => Object.fromEntries(Object.entries(aggregations || {}).map(([name, agg]) => {
  const childrenKey = agg.aggregations ? 'aggregations' : 'aggs';
  const children = rewriteAggregations(agg[childrenKey], paths, resources);
  const result = rewriteQuery(agg, paths, resources);
  if (Object.keys(children).length) result[childrenKey] = children;
  if (paths.has(agg.nested?.path)) {
    result[childrenKey] = { [VISIBLE_AGG]: {
      filter: ownershipQuery(resources, paths.get(agg.nested.path)),
      aggs: children,
    } };
  }
  if (agg.global) {
    result[childrenKey] = { [VISIBLE_AGG]: { filter: visibilityQuery(resources), aggs: children } };
  }
  if (result.top_hits) {
    result.top_hits = { ...result.top_hits, _source: true };
    if (result.top_hits.sort) result.top_hits.sort = rewriteSort(result.top_hits.sort, paths, resources);
  }
  return [name, result];
}));
const rewriteSort = (sort, paths, resources) => {
  if (!sort) return sort;
  return [].concat(sort).map((entry) => {
    if (typeof entry !== 'object') {
      if (typeof entry === 'string' && [...paths.keys()].some((path) => entry.startsWith(`${path}.`))) throw new CodedError(400, 'File sorting requires a correlated nested sort');
      return entry;
    }
    return Object.fromEntries(Object.entries(entry).map(([field, options]) => {
      const owner = [...paths.keys()].filter((path) => field.startsWith(`${path}.`)).sort((a, b) => b.length - a.length)[0];
      if (!owner) return [field, options];
      const opts = typeof options === 'object' ? options : { order: options };
      if (opts.nested?.path !== owner) throw new CodedError(400, 'File sorting requires a correlated nested sort');
      return [field, { ...opts, nested: { ...opts.nested, filter: filtered(rewriteQuery(opts.nested.filter, paths, resources), ownershipQuery(resources, paths.get(owner))) } }];
    }));
  });
};

export const applyFileVisibility = (body, indexer) => {
  if (!config.fileVisibilityEnabled) return body;
  const paths = protectedFilePaths(indexer);
  checkQuery(body, paths);
  if (hasGlobalAggregation(body.aggs) || hasGlobalAggregation(body.aggregations)) {
    throw new CodedError(400, 'Aggregations cannot bypass file visibility');
  }
  const resources = visibilityContext.getStore()?.resources || [];
  const result = { ...body, _source: true,
    query: filtered(rewriteQuery(body.query, paths, resources), visibilityQuery(resources)),
  };
  if (body.post_filter) result.post_filter = rewriteQuery(body.post_filter, paths, resources);
  if (body.aggs) result.aggs = rewriteAggregations(body.aggs, paths, resources);
  if (body.aggregations) result.aggregations = rewriteAggregations(body.aggregations, paths, resources);
  if (body.sort) result.sort = rewriteSort(body.sort, paths, resources);
  return result;
};

const readable = (required, resources) => Array.isArray(required) && required.length > 0 && required.every((r) => typeof r === 'string' && resources.includes(r));
export const redactFileSource = (source, resources) => {
  if (Array.isArray(source)) return source.map((item) => redactFileSource(item, resources)).filter((item) => item !== undefined);
  if (!source || typeof source !== 'object') return source;
  if (Object.prototype.hasOwnProperty.call(source, FILE_AUTHZ) && !readable(source[FILE_AUTHZ], resources)) return undefined;
  const result = {};
  Object.entries(source).forEach(([key, value]) => {
    if (key.startsWith('_gen3_file_')) return;
    const clean = redactFileSource(value, resources);
    if (clean !== undefined) result[key] = clean;
  });
  if (source.summary && typeof source.summary === 'object') {
    result.summary = { ...result.summary };
    fileSummaryKeys.forEach((key) => { delete result.summary[key]; });
    if (Array.isArray(source._gen3_file_summary)) {
      const rows = source._gen3_file_summary.filter((row) => readable(row.authz, resources));
      result.summary.file_count = rows.reduce((total, row) => total + row.file_count, 0);
      result.summary.file_size = rows.reduce((total, row) => total + row.file_size, 0);
      [['data_category', 'data_categories'], ['experimental_strategy', 'experimental_strategies']].forEach(([field, plural]) => {
        const groups = new Map();
        rows.forEach((row) => [].concat(row[field] || []).forEach((value) => {
          const group = groups.get(value) || { count: 0, cases: new Set() };
          group.count += row.file_count;
          (row.case_ids || []).forEach((id) => group.cases.add(id));
          groups.set(value, group);
        }));
        result.summary[plural] = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, group]) => ({ [field]: value, file_count: group.count, ...(Object.prototype.hasOwnProperty.call(source.summary, 'case_count') ? { case_count: group.cases.size } : {}) }));
      });
    }
  }
  return result;
};
const scrub = (value, resources) => {
  if (Array.isArray(value)) return value.map((item) => scrub(item, resources));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if (key === VISIBLE_AGG) return;
    if (key === '_source') result[key] = redactFileSource(item, resources) || {};
    else result[key] = scrub(item, resources);
  });
  if (value[VISIBLE_AGG]) Object.assign(result, scrub(value[VISIBLE_AGG], resources));
  return result;
};
export const redactFileResponse = (response) => (config.fileVisibilityEnabled
  ? scrub(response, visibilityContext.getStore()?.resources || []) : response);

// Fetch ownership before applying caller source projection. Otherwise requesting
// only file_name would remove the information needed to redact private children.
export const projectFileSource = (source, selection) => {
  if (selection === undefined || selection === true) return source;
  if (selection === false) return {};
  const filters = typeof selection === 'object' && !Array.isArray(selection) ? selection : { includes: [].concat(selection) };
  const includes = [].concat(filters.includes || filters.include || ['*']);
  const excludes = [].concat(filters.excludes || filters.exclude || []);
  const matches = (pattern, path) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}(?:\\.|$)`).test(path);
  };
  const visit = (value, path = '', inherited = false) => {
    if (path && excludes.some((pattern) => matches(pattern, path))) return undefined;
    const selectedHere = inherited || (path && includes.some((pattern) => matches(pattern, path)));
    if (Array.isArray(value)) {
      const items = value.map((item) => visit(item, path, selectedHere)).filter((item) => item !== undefined);
      return items.length || selectedHere || includes.some((pattern) => pattern.startsWith(`${path}.`)) ? items : undefined;
    }
    if (value && typeof value === 'object') {
      const result = {};
      Object.entries(value).forEach(([key, item]) => {
        const selected = visit(item, path ? `${path}.${key}` : key, selectedHere);
        if (selected !== undefined) result[key] = selected;
      });
      return Object.keys(result).length ? result : undefined;
    }
    return selectedHere ? value : undefined;
  };
  return visit(source) || {};
};
export const projectFileResponse = (response, selection) => {
  if (!config.fileVisibilityEnabled || selection === undefined || selection === true || !response.hits) return response;
  return { ...response, hits: { ...response.hits, hits: response.hits.hits.map((hit) => ({ ...hit, _source: projectFileSource(hit._source, selection) })) } };
};
