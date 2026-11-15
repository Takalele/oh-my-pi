# Merging upstream into `feat/antigravity-acp-compliance` (Antigravity)

Policy: **our `antigravity` provider (API id `antigravity-acp`, official ACP binary) is the only
Antigravity path.** Upstream's `antigravity-cli` provider (`agy acp`, added in upstream
`c3b7bed169`) and the old `google-antigravity` OAuth provider stay **out**.

The clash is real: upstream also uses the API id `antigravity-acp` for its provider, so a naive
merge yields duplicate `case "antigravity-acp"` labels, a doubled `BUILTIN_API_IDS` entry, and
orphan references. The repo script handles the known shape of that clash.

## Normal flow

```bash
git fetch https://github.com/can1357/oh-my-pi.git main:upstream_main
git checkout feat/antigravity-acp-compliance
git merge upstream_main
bash scripts/drop-antigravity-cli.sh          # add --test to also run the narrow suites
git add -A
bun run check:ts
git commit --no-edit                           # or amend the merge message
git push
```

The script:

1. Resolves the known conflict markers (ours for the branch provider files, upstream for the two
   doc/test bullets it rewrote, custom scope for `classes/gemini.kdl`).
2. Deletes the `antigravity-cli` source/test/rule files.
3. Strips cli references from `stream.ts`, `api-registry.ts`, `types.ts`, `dirs.ts`, the login
   hooks, `login-order`, and the dead `google-antigravity` test scaffolding.
4. Regenerates `rules.json` (`bun run gen:compat`) and `models.json`
   (`gen:models --provider antigravity`, then a codec strip of the two provider rows via
   `model-catalog-format`).

It never commits.

## If the patch fails

The script assumes upstream re-landed the provider in the same shape. It will not be true after
upstream refactors. Work the merge by hand with this checklist:

### 1. Find every clash site

```bash
git status --porcelain | grep -E '^(UU|DU|UD)'          # conflicted paths
grep -rln 'antigravity-cli\|AntigravityCli' packages docs | grep -v node_modules
grep -rln 'google-antigravity' packages docs | grep -v node_modules | grep -v CHANGELOG
```

### 2. API id `antigravity-acp` is claimed twice — keep the branch side

- `packages/ai/src/stream.ts`: exactly one `case "antigravity-acp"` per switch
  (`stream()` dispatch → `streamAntigravityAcp`; `mapOptionsForApi` → the branch's
  `castApi` block with `cursorOnToolResult`). Delete the `streamAntigravityCli`/`agyModel` variants
  and the `AntigravityCliOptions` import.
- `packages/ai/src/api-registry.ts`: `"antigravity-acp"` appears once in `BUILTIN_API_IDS`.
- `packages/ai/src/types.ts`: `"antigravity-acp": AntigravityAcpOptions`; delete
  `AntigravityCliCheckpoint`/`AntigravityCliPayload` and the `antigravityEndpointMode` option
  (cli-only).
- `packages/ai/src/registry/hooks/custom.ts`: keep the `antigravity-acp` login/refresh hooks.
- `packages/catalog/scripts/compat-compiler/compile-providers.ts`: `KNOWN_APIS` lists
  `"antigravity-acp"` once.

### 3. Delete upstream files, don't merge them

```
packages/ai/src/providers/antigravity-cli{.ts,/**}
packages/ai/src/registry/oauth/antigravity-cli.ts
packages/ai/test/antigravity-cli-*.test.ts
packages/catalog/src/compat/rules/{auth,providers}/antigravity-cli.kdl
packages/catalog/src/compat/rules/auth/google-antigravity.kdl   (branch removed this provider)
packages/ai/test/{auth-storage-antigravity-selection,provider-login-warning}.test.ts
```

### 4. Catalog files are generated — never hand-merge

- `rules.json` + `auth-ids.ts`/`provider-ids.ts`: take ours, then `bun run gen:compat`
  (it regenerates all three from the KDL tree; also removes the dead `antigravity-cli` id from the
  `_order.kdl` login list first).
- `models.json` (marked binary in `.gitattributes`, so git always conflicts on it):
  ```bash
  git checkout upstream_main -- packages/catalog/src/models.json
  bun --cwd=packages/catalog run gen:models --provider antigravity
  ```
  then strip the `antigravity-cli` and `google-antigravity` provider rows with the repo codec
  (`openModelCatalog`/`getCatalogProviders`/`getCatalogProvider`/`encodeModelCatalog` from
  `packages/catalog/src/model-catalog-format.ts`) — the same one-liner the script runs.
  **Do not** run full `gen:models` without `--provider`: live discovery re-bakes every provider's
  rows and drifts the committed snapshot (e.g. the OpenRouter roster) off upstream.

### 5. Tests that reference the deleted providers

- Drop upstream's `google-antigravity`/`antigravity-cli` test blocks
  (`compat-collapse.test.ts`, `model-discovery.test.ts`, `image-gen.test.ts`,
  `google-gemini-cli-variant-routing.test.ts`).
- Delete the `vi.spyOn(compatAuth, "providerDisabledReason")` unpausing lines — they existed only
  for the paused `google-antigravity` provider; nothing pauses anymore.
- Keep upstream's unrelated rewrites (e.g. the "Thought parts & signature retention" bullet now
  describing Vertex behavior; the gemini.kdl `on-api "google-vertex"` first-function-call block) —
  only strip the `google-antigravity` host from the flash-workaround scope and the word
  "Antigravity" from doc/test wording.

### 6. Docs and changelogs

- `docs/providers.md`: delete the `## Antigravity CLI` section, keep `## Google Antigravity`.
- `docs/settings.md` + `docs/provider-quirks.md`: remove `google-antigravity` examples.
- `[Unreleased]` changelog entries for `antigravity-cli`: delete. Never touch released sections.

### 7. Verify before committing

```bash
bun run check:ts
bun --cwd=packages/catalog test test/build.test.ts test/compat-collapse.test.ts
bun --cwd=packages/ai test test/antigravity-acp-*.test.ts
bun --cwd=packages/coding-agent test test/model-discovery.test.ts
grep -rn 'antigravity-cli' packages docs | grep -v node_modules   # must be empty
```

Then build & install (see below).

## Build & install (after the merge)

```bash
bun run setup                    # deps + native addon + dev wrapper (~/.bun/bin/omp)
bun --cwd=packages/coding-agent run build   # real binary -> packages/coding-agent/dist/omp
mv -f packages/coding-agent/dist/omp ~/.local/bin/omp
~/.local/bin/omp --version && ~/.local/bin/omp --smoke-test
```

`mv` (atomic rename), not `cp`: the old binary may still be running in the current session and
`cp` fails with "Text file busy".
