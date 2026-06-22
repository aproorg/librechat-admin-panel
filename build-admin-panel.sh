#!/usr/bin/env bash
# Build this admin panel (Node/Bun) into a Lambda deployment zip.
#
# Output zip: $1 (the aprochat-config terraform_data passes a source-hashed
# path), else dist/lambda/package.zip. `index.mjs` + `client/` at the zip root,
# matching handler `index.handler` and the handler's `./client` path.
#
# Requires: bun, zip. Invoked via `bash` by terraform_data.build_admin_panel
# during apply (also runnable standalone). Excluded from the Docker image via
# .dockerignore and absent from the lambda zip (built from dist/lambda only).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUT_ZIP="${1:-$HERE/dist/lambda/package.zip}"
case "$OUT_ZIP" in /*) ;; *) OUT_ZIP="$PWD/$OUT_ZIP" ;; esac  # absolutize before any cd
OUT_DIR="$(dirname "$OUT_ZIP")"

if [ ! -f "$HERE/package.json" ]; then
  echo "must run from the admin-panel checkout (no package.json at $HERE)" >&2
  exit 1
fi

cd "$HERE"
bun install --frozen-lockfile
bun run build:lambda:alb

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"
(cd "$HERE/dist/lambda" && zip -rq "$OUT_ZIP" index.mjs client)
echo "Built $OUT_ZIP ($(du -h "$OUT_ZIP" | cut -f1))"
