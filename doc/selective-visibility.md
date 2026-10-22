# Opt-in project file metadata visibility

`PROJECT_VISIBILITY_ENABLED=true` enforces `indexd/read-metadata` grants from
standard user YAML/Arborist on existing IndexD AuthZ ownership. It defaults to
false, retaining existing search behavior for commons that do not opt in.
Fence's `read-storage` grants remain independent.

Before enabling, prepare **every** served search projection with
`_gen3_file_visibility_version: 1` and canonical `_gen3_file_authz` ownership from
IndexD. Ownership belongs on files and their references, not on public clinical
cases merely because they contain private files. Owned embedded objects require
nested mappings, keyword ownership with doc values, and no parent `copy_to` or
`include_in_parent`/`include_in_root` copies. Search rejects unsafe mappings.

Query, count, facet, export and pagination filters run before Elasticsearch
results are counted. Nested file queries/facets/sorts enforce each child's own
resources. Global facets receive a visibility filter too. Source responses fetch
ownership before projection, remove unauthorized files, strip internal fields,
and recompute file summaries from unindexed `_gen3_file_summary` contribution
groups. Public case details and visible files remain available. Grants require
all listed owners, including referenced private input/index files.

Queries, sorts and aggregations over old stored `summary.file_count`, `file_size`,
`data_categories` and `experimental_strategies` are rejected because their stored
values contain unfiltered totals; use the filtered file index for these queries.
Their source-response values are recalculated. User scripts, background-statistic
aggregations and zero-count terms that can bypass filtering are rejected.

Changing user/group visibility requires ordinary usersync, without modifying
IndexD records or reindexing. Changing a file's ownership or ingesting/rebuilding
projections requires synchronized ownership preparation. Queries resolve and pin
validated physical indices to avoid alias-switch races; this adds a mapping read
per request and should be measured during dev acceptance.

Peregrine/Sheepdog graph reads, MDS and other stores need coordinated protection
before claiming hidden files cannot be discovered. Clinical/genomic row permissions
are otherwise deferred. Do not enable against unprepared indices or treat an
opt-out rollback as preserving private metadata.
