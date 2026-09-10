# MMRF authenticated metadata collection

This MMRF image authorizes its configured metadata indices as one collection. `METADATA_AUTH_RESOURCE` defaults to `/mmrf_metadata`. It requires site-wide private tier access and a real Arborist service; libre, mock and internal-local-test configurations fail startup instead of silently disabling protection.

This default is intentional for the MMRF deployment branch, not an upstream Gen3 default. The current upstream Helm deployment does not expose arbitrary environment variables for an opt-in switch. Removing the default alone would disable collection authorization in the coordinated deployment. The startup rejection of incompatible configurations is intentional; use the existing image for legacy environments until their rollout is ready.

Every GraphQL query and metadata download requires a caller token. Bearer headers and the `access_token` browser cookie are supported. Arborist checks `guppy/read` on the collection resource. A successful check permits the user's query against all configured indices without referencing a nonexistent per-record ACL field. No token, permission denial, malformed authorization response, and authorization-service failure all deny access. Anonymous `/open` grants cannot bypass the token requirement.

This matches the current MMRF policy that all approved accounts can query all analysis metadata. It is not project-specific or row-level authorization. If that policy changes, configure and populate indexed resource paths and replace collection-level authorization accordingly. Do not use this MMRF image for a commons requiring per-project metadata filtering without adapting it.

`read-storage` is not checked or granted. Guppy's `/download` exports metadata, not the protected repository files managed by Fence. Responses are private and non-cacheable. The public health endpoint reports only health status, not the list of Elasticsearch indices.

In collection mode `_refresh` is deliberately unavailable; use a rolling restart to refresh the schema. This avoids granting a schema-administration capability to metadata readers. Existing per-record authorization test fixtures remain separate from this MMRF mode.

Run focused tests:

```sh
npm test -- src/server/auth/__tests__/metadataAccess.test.js --runInBand
```

Coordinate rollout with `gen3-analysis`, `ppmmrf`, the dev `mmrf-users` policy and dev GitOps values. Do not deploy this image against unchanged libre values.
