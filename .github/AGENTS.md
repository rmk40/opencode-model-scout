# CI/Publishing Learnings

## npm Trusted Publishing (OIDC)

- Requires Node 24+ (ships npm 11.5.1+). npm 10.x only supports provenance signing via OIDC, not tokenless publishing.
- `NODE_AUTH_TOKEN: ""` in the publish step is critical. `actions/setup-node` injects a placeholder token (`XXXXX-XXXXX-XXXXX-XXXXX`) that overrides OIDC. Setting it to empty string clears it so npm falls through to OIDC auth.
- The 404 error from npm on publish with an invalid token is misleading — it looks like a missing package, not an auth failure. npm returns 404 instead of 401 on PUT with bad tokens.
- `publishConfig.provenance: true` in package.json makes provenance automatic. No `--provenance` flag needed in CI.
- Trusted publisher config on npmjs.com must match exactly: owner, repo, workflow filename. No environment field.

## Workflow Quirks

- `persist-credentials: false` on `release.yml` (no git push needed) but NOT on `latest.yml` — it needs git credentials for `git push origin :refs/tags/latest` tag cleanup.
- `prepack` lifecycle runs automatically on both `npm publish` and `npm pack`. Our `prepack` script runs `compile` (tsup). So `npm publish` compiles twice in CI (explicit step + lifecycle) — harmless, `--clean` ensures idempotency.
- The `latest.yml` snapshot needs `concurrency: { group: latest-snapshot, cancel-in-progress: true }` — rapid pushes to main can race on delete/create of the `latest` release.
- `sleep 2` after deleting the latest release avoids a GitHub API race where the tag still exists briefly after the release is deleted.
