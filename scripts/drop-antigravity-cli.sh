#!/usr/bin/env bash
# Drop the upstream `antigravity-cli` provider; keep our `antigravity-acp`.
#
# Use after merging upstream main when can1357 re-lands (or keeps) the
# antigravity-cli provider. Idempotent: safe to re-run. Works mid-merge
# (resolves the known conflict markers) and on a clean tree (strips residue).
#
# Usage:
#   bash scripts/drop-antigravity-cli.sh           # resolve + strip + regenerate
#   bash scripts/drop-antigravity-cli.sh --test    # also run the narrow test suites
#
# It does NOT commit. Review `git status`, then commit yourself.
# If it errors mid-way, see docs/antigravity-merge.md ("If the patch fails").
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

run_tests=0
[ "${1:-}" = "--test" ] && run_tests=1

echo "==> Resolving known antigravity merge conflicts (if any)"
python3 - <<'PYEOF'
import os, re, sys

def resolve_markers(path, side_per_hunk, custom=None):
    """Remove conflict markers, choosing 'ours'/'theirs' per hunk (index-clamped)."""
    try:
        with open(path) as f:
            lines = f.read().split("\n")
    except FileNotFoundError:
        return 0
    if not any(l.startswith("<<<<<<< ") for l in lines):
        return 0
    out, i, hunk = [], 0, 0
    while i < len(lines):
        if lines[i].startswith("<<<<<<< "):
            i += 1
            ours, theirs = [], []
            while not lines[i].startswith("======="):
                ours.append(lines[i]); i += 1
            i += 1
            while not lines[i].startswith(">>>>>>> "):
                theirs.append(lines[i]); i += 1
            i += 1
            if custom:
                out = custom(out, ours, theirs)
            else:
                side = side_per_hunk[min(hunk, len(side_per_hunk) - 1)]
                out.extend(ours if side == "ours" else theirs)
            hunk += 1
            continue
        out.append(lines[i])
        i += 1
    text = "\n".join(out)
    assert "<<<<<<<" not in text and ">>>>>>> " not in text, f"markers remain in {path}"
    with open(path, "w") as f:
        f.write(text)
    print(f"    resolved markers: {path}")
    return 1

# keep-ours files: branch implementation wins
for p in [
    "packages/ai/src/providers/register-builtins.ts",
    "packages/ai/src/registry/hooks/custom.ts",
    "packages/ai/src/types.ts",
    "packages/catalog/src/compat/auth-ids.ts",
    "packages/catalog/src/compat/provider-ids.ts",
    "packages/catalog/src/compat/rules.json",
    "packages/catalog/src/compat/rules/auth/_order.kdl",
    "packages/catalog/test/compat-collapse.test.ts",
    "packages/coding-agent/test/model-discovery.test.ts",
    "packages/coding-agent/test/tools/image-gen.test.ts",
    "packages/ai/test/google-gemini-cli-variant-routing.test.ts",
]:
    resolve_markers(p, ["ours"])

# keep-theirs files: upstream rewrote these bullets; wording strip runs later
for p in [
    "docs/provider-quirks.md",
    "packages/ai/test/google-gemini3-unsigned-tool-call.test.ts",
]:
    resolve_markers(p, ["theirs"])

# gemini.kdl: keep upstream's vertex block, but the flash-workaround scope
# must be the branch's (no google-antigravity host).
def gemini_custom(out, ours, theirs):
    if theirs and theirs[-1] == '\ton "google-antigravity" "google-gemini-cli" {':
        return out + theirs[:-1] + ['\ton "google-gemini-cli" {']
    return out + ours
resolve_markers("packages/catalog/src/compat/rules/classes/gemini.kdl", ["ours"], custom=gemini_custom)

print("    done")
PYEOF

echo "==> Removing upstream antigravity-cli files"
for f in \
  packages/ai/src/providers/antigravity-cli.ts \
  packages/ai/src/providers/antigravity-cli \
  packages/ai/src/registry/oauth/antigravity-cli.ts \
  packages/ai/test/antigravity-cli-binary.test.ts \
  packages/ai/test/antigravity-cli-conversation-store.test.ts \
  packages/ai/test/antigravity-cli-credentials.test.ts \
  packages/ai/test/antigravity-cli-host.test.ts \
  packages/ai/test/antigravity-cli-mcp-bridge.test.ts \
  packages/ai/test/antigravity-cli-reconcile.test.ts \
  packages/catalog/src/compat/rules/auth/antigravity-cli.kdl \
  packages/catalog/src/compat/rules/providers/antigravity-cli.kdl \
  packages/catalog/src/compat/rules/auth/google-antigravity.kdl \
  packages/ai/test/auth-storage-antigravity-selection.test.ts \
  packages/ai/test/provider-login-warning.test.ts; do
  if [ -e "$f" ]; then
    rm -rf "$f"
    # Unstage the merge-added copy if a merge is in progress.
    git rm -q -f -r --ignore-unmatch "$f" 2>/dev/null || true
    echo "    removed: $f"
  fi
done

echo "==> Stripping antigravity-cli references from shared files"
python3 - <<'PYEOF'
import re

def edit(path, *pairs):
    try:
        s = open(path).read()
    except FileNotFoundError:
        return 0
    n = 0
    for old, new in pairs:
        while old in s:
            s = s.replace(old, new)
            n += 1
    if n:
        open(path, "w").write(s)
        print(f"    edited: {path} ({n} replacements)")
    return n

STREAM_CASE_RE = (
    r'\t\tcase "antigravity-acp":\n'
    r'\t\t\treturn streamAntigravityCli\(\n'
    r'(?:\t+\S.*\n)+?'
    r'\t\t\);\n\n?'
)
MAP_CASE_RE = (
    r'\t\tcase "antigravity-acp": \{\n'
    r'\t\t\tconst agyModel = model as Model<"antigravity-acp">;\n'
    r'(?:\t+.*\n)+?'
    r'\t\t\}\n'
)
CHECKPOINT_RE = r'/\*\* Row counts of an agy conversation store.*?\n\}\n\n'
PAYLOAD_RE = r'/\*\*\n \* Where an Antigravity CLI.*?\n\}\n\n'
ENDPOINT_RE = r'\t/\*\* Antigravity endpoint routing mode:.*?\nantigravityEndpointMode[^;]*;\n'

edit(
    "packages/ai/src/stream.ts",
    ('import type { AntigravityCliOptions } from "./providers/antigravity-cli";\n', ""),
    ("\tstreamAntigravityCli,\n", ""),
)
for p in ["packages/ai/src/stream.ts"]:
    s = open(p).read()
    s2, n1 = re.subn(STREAM_CASE_RE, "", s)
    s2, n2 = re.subn(MAP_CASE_RE, "", s2)
    if n1 or n2:
        open(p, "w").write(s2)
        print(f"    edited: {p} (case blocks: {n1 + n2})")

edit(
    "packages/ai/src/api-registry.ts",
)
# dedupe the antigravity-acp entry in BUILTIN_API_IDS
s = open("packages/ai/src/api-registry.ts").read()
first = s.find('"antigravity-acp"')
if first != -1:
    second = s.find('"antigravity-acp"', first + 1)
    if second != -1:
        line_end = s.index("\n", second)
        line_start = s.rfind("\n", 0, second) + 1
        s = s[:line_start] + s[line_end + 1:]
        open("packages/ai/src/api-registry.ts", "w").write(s)
        print("    edited: packages/ai/src/api-registry.ts (deduped antigravity-acp)")

edit(
    "packages/ai/src/types.ts",
    ('import type { AntigravityCliOptions } from "./providers/antigravity-cli";\n', ""),
    ("\t| GeminiNativeContentPayload\n\t| AntigravityCliPayload;", "\t| GeminiNativeContentPayload;"),
)
s = open("packages/ai/src/types.ts").read()
s2 = re.sub(CHECKPOINT_RE, "", s)
s2 = re.sub(PAYLOAD_RE, "", s2)
s2 = re.sub(ENDPOINT_RE, "", s2)
if s2 != s:
    open("packages/ai/src/types.ts", "w").write(s2)
    print("    edited: packages/ai/src/types.ts (cli payload types)")

edit(
    "packages/utils/src/dirs.ts",
    ('/** Get the managed Antigravity CLI directory (~/.omp/antigravity-cli): the `agy` binary and its isolated state. */\n'
     "export function getAntigravityCliDir(): string {\n"
     '\treturn dirs.rootSubdir("antigravity-cli", "data");\n'
     "}\n", ""),
)

# login/refresh hooks: keep antigravity-acp, drop antigravity-cli
edit(
    "packages/ai/src/registry/hooks/custom.ts",
    ('\t"antigravity-cli": () => import("../oauth/antigravity-cli").then(module => module.loginAntigravityCli),\n', ""),
    ('\t"antigravity-cli": () => import("../oauth/antigravity-cli").then(module => module.refreshAntigravityCli),\n', ""),
)

# login-order: drop the id from the KDL list line
s = open("packages/catalog/src/compat/rules/auth/_order.kdl").read()
if '"antigravity-cli"' in s:
    s = s.replace('"antigravity-cli" ', "").replace('"antigravity-cli"', "")
    open("packages/catalog/src/compat/rules/auth/_order.kdl", "w").write(s)
    print("    edited: packages/catalog/src/compat/rules/auth/_order.kdl")

# test files: drop dead unpausing of the (deleted) paused provider
UNPAUSE = (
    "\t// Antigravity is paused in its auth rules; its transport stays for when it is turned back on.\n"
    '\tbeforeEach(() => vi.spyOn(compatAuth, "providerDisabledReason").mockReturnValue(undefined));\n'
    "\tafterEach(() => vi.restoreAllMocks());\n\n"
)
for f in [
    "packages/ai/test/google-gemini-cli-3x-thinking.test.ts",
    "packages/ai/test/google-thinking-output-cap.test.ts",
]:
    edit(
        f,
        (UNPAUSE, ""),
        ('import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";', 'import { describe, expect, it } from "bun:test";'),
        ('import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";\n', ""),
    )

edit(
    "packages/coding-agent/test/task/prompt-cache.test.ts",
    ("\t\t\t// Antigravity is paused in its auth rules; its transport stays for when it is turned back on.\n"
     '\t\t\tif (provider === "google-antigravity") {\n'
     '\t\t\t\tvi.spyOn(compatAuth, "providerDisabledReason").mockReturnValue(undefined);\n'
     "\t\t\t}\n", ""),
    ('import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";\n', ""),
)

# wording: Antigravity is no longer a first-class host in these docs/tests
edit(
    "docs/provider-quirks.md",
    ("Cloud Code Assist / Antigravity and Vertex AI emit it only", "Cloud Code Assist and Vertex AI emit it only"),
)
edit(
    "packages/ai/test/google-gemini3-unsigned-tool-call.test.ts",
    ("//   - CCA/Antigravity & Vertex: substitute it only when the first call is unsigned.",
     "//   - CCA & Vertex: substitute it only when the first call is unsigned."),
)

# docs: drop the Antigravity CLI section and the stale paused-provider example
s = open("docs/providers.md").read()
m = re.search(r"^## Antigravity CLI\n.*?(?=^## )", s, flags=re.M | re.S)
if m:
    open("docs/providers.md", "w").write(s[:m.start()] + s[m.end():])
    print("    edited: docs/providers.md (removed Antigravity CLI section)")

edit(
    "docs/settings.md",
    ("(for example `google-antigravity`)", "(for example `openrouter`)"),
    ("   unpausedProviders:\n      - google-antigravity", "   unpausedProviders:\n      - openrouter"),
)

# changelog: drop the unreleased antigravity-cli entries (released sections are immutable)
edit(
    "packages/ai/CHANGELOG.md",
    ("- Added the Antigravity CLI ACP provider with managed installation, Google sign-in, refreshable distributed credentials, host tools, and retained conversations across tool steps and history changes.\n", ""),
)
edit(
    "packages/catalog/CHANGELOG.md",
    ("- Added Antigravity CLI models for Gemini, Claude and GPT-OSS with selectable native thinking levels.\n", ""),
)
edit(
    "packages/utils/CHANGELOG.md",
    ("- Added a profile-aware data directory for managed Antigravity CLI installations and isolated account state.\n", ""),
)
edit(
    "packages/coding-agent/CHANGELOG.md",
    ("- Added the `antigravity-cli` provider for Google Antigravity over ACP, with managed binary installation, `/login antigravity-cli` Google sign-in, host tool execution, and retained conversations across tool steps and history changes.\n", ""),
)
print("    done")
PYEOF

echo "==> Regenerating rules.json"
bun run gen:compat

echo "==> Regenerating models.json (antigravity rows + strip dropped providers)"
bun --cwd=packages/catalog run gen:models --provider antigravity
bun - <<'EOF'
import * as fs from "node:fs";
import {
	encodeModelCatalog,
	getCatalogProvider,
	getCatalogProviders,
	openModelCatalog,
} from "./packages/catalog/src/model-catalog-format.ts";

const p = "packages/catalog/src/models.json";
const catalog = openModelCatalog(JSON.parse(fs.readFileSync(p, "utf8")));
const ids = getCatalogProviders(catalog);
const drop = new Set(["antigravity-cli", "google-antigravity"]);
const models: Record<string, unknown> = {};
for (const id of ids) {
	if (drop.has(id)) continue;
	models[id] = getCatalogProvider(catalog, id);
}
fs.writeFileSync(p, encodeModelCatalog(models as never));
const check = openModelCatalog(JSON.parse(fs.readFileSync(p, "utf8")));
console.log(`    providers: ${getCatalogProviders(check).length}, antigravity kept: ${!!getCatalogProvider(check, "antigravity")}`);
EOF

echo "==> Leftover scan"
leftover=0
while IFS= read -r line; do
	echo "    LEFTOVER: $line"
	leftover=1
done < <(grep -rn 'antigravity-cli\|AntigravityCli\|antigravityCli' packages docs 2>/dev/null \
	| grep -v node_modules | grep -v 'CHANGELOG.md' | grep -v '/dist/' | grep -v 'docs/antigravity-merge.md' || true)
if [ "$leftover" -eq 0 ]; then
	echo "    clean"
fi

echo
echo "Done. Review, then commit:"
echo "  git add -A && git status"
echo "  bun run check:ts"
if [ "$run_tests" -eq 1 ]; then
	echo "==> Running narrow test suites"
	bun --cwd=packages/catalog test test/build.test.ts test/compat-collapse.test.ts
	bun --cwd=packages/ai test test/antigravity-acp-discovery.test.ts test/antigravity-acp-provider.test.ts \
		test/google-gemini3-unsigned-tool-call.test.ts test/google-gemini-cli-variant-routing.test.ts \
		test/google-gemini-cli-3x-thinking.test.ts test/google-thinking-output-cap.test.ts
	bun --cwd=packages/coding-agent test test/model-discovery.test.ts test/tools/image-gen.test.ts test/task/prompt-cache.test.ts
	bun --cwd=packages/utils test test/antigravity-auth.test.ts test/antigravity-install.test.ts
fi
