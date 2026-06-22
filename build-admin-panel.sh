#!/usr/bin/env bash
# Build this admin panel (Node/Bun) into a Lambda deployment zip.
#
# Output zip: $1 (the aprochat-config terraform_data passes a source-hashed
# path), else dist/lambda/package.zip. `index.mjs` + `client/` at the zip root,
# matching handler `index.handler` and the handler's `./client` path.
#
# Requires: zip (and bun, which is bootstrapped below if absent). Invoked via
# `bash` by the aprochat-config build (also runnable standalone). Excluded from
# the Docker image via .dockerignore and absent from the lambda zip (built from
# dist/lambda only). All tooling output goes to stderr so callers (terraform's
# data.external) can keep stdout clean.
set -euo pipefail

BUN_VERSION="1.3.11"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUT_ZIP="${1:-$HERE/dist/lambda/package.zip}"
case "$OUT_ZIP" in /*) ;; *) OUT_ZIP="$PWD/$OUT_ZIP" ;; esac  # absolutize before any cd
OUT_DIR="$(dirname "$OUT_ZIP")"

if [ ! -f "$HERE/package.json" ]; then
  echo "must run from the admin-panel checkout (no package.json at $HERE)" >&2
  exit 1
fi

# Bootstrap bun if the build host doesn't provide it (don't depend on the
# CodeBuild buildspec — its inline form can be reverted by unrelated deploys).
if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found; bootstrapping bun ${BUN_VERSION}..." >&2
  export BUN_INSTALL="${BUN_INSTALL:-/tmp/bun-runtime}"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" >&2
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

cd "$HERE"
bun install --frozen-lockfile
# --bun forces vite (a `#!/usr/bin/env node` bin) to run under bun. The build
# host's ambient node may predate the CustomEvent global that vite 8's CLI
# needs; bun has it. Mirrors the node-less oven/bun Docker image.
bun run --bun build:lambda:alb

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"
(cd "$HERE/dist/lambda" && zip -rq "$OUT_ZIP" index.mjs client)
echo "Built $OUT_ZIP ($(du -h "$OUT_ZIP" | cut -f1))"
