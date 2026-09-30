# Selective file visibility

`FILE_VISIBILITY_ENABLED=true` opts into private discovery, alongside the current
MMRF metadata authorization. It defaults to false. The Helm chart's additional
`guppy.env` supports this flag. With the flag enabled, every searchable document
must have `_gen3_visibility: public` or `_gen3_visibility: restricted`; **unmarked
or unknown documents are hidden**. The restricted form must include a nonempty
keyword array `_gen3_visibility_authz` of canonical Arborist resources.

The caller needs `fence/read-storage` on every resource, in addition to normal
metadata access. The same Arborist mapping handles group grants and wildcard
actions. Request-scoped AsyncLocalStorage prevents permissions crossing users.
Filtering wraps the ES query before projection, facets, pagination, scroll
exports, and query caching. Cache keys include the effective resources. A global
aggregation is rejected because Elasticsearch would otherwise ignore the query.
No field projection can remove the policy before it is applied.

Prepare *all* file, case, gene, mutation, CNV and project projections before
turning on this flag. A parent containing restricted children must require the
union of their resources; parent redaction is deliberately conservative. Use
MMRF's `prepare-file-visibility.py --resource /private-project` for an entire
private dataset, including projections which do not contain file GUIDs. A full
IndexD manifest can also mark mixed documents containing private references.
Do not label derived private metadata public just because it lacks a GUID.

Search markers are an ingestion contract, not an automatic IndexD-to-ES sync.
When restricting previously public data, remove its old public search copies
from served aliases/caches first, rebuild all derivatives with restrictions,
and atomically publish the prepared indices. Reindex jobs must always run the
preparation step; unprepared documents remain hidden with the feature enabled.
Do not disable the feature or restore old public indices while private data is
present. See the coordinated MMRF GitOps runbook and readiness validator.

Run `npm test -- --runInBand src/server/auth/__tests__/fileVisibility.test.js`
and existing `metadataAccess.test.js`. Set `VISIBILITY_TEST_ES_URL` to a disposable
ES 7 cluster to run `fileVisibility.integration.test.js`, covering hits, facets,
scroll exports, all-resource grants and concurrent cache separation.
