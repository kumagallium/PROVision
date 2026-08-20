#!/usr/bin/env bash
# PROVision の図版グラフと asterism の測定データを 1 つのストアに載せ、
# 横断クエリを流す。サーバは立てない（oxigraph の load / query を 1 発ずつ使う）。
#
#   scripts/crossgraph-query.sh queries/figure-to-data.rq [asterism のクローン先]
#
# 前提: docker が動いていること。asterism のデモデータ
#   docs/demo/data/starrydata-demo.ttl を読む。
set -euo pipefail

QUERY="${1:-queries/figure-to-data.rq}"
ASTERISM="${2:-$HOME/develop/asterism}"
DEMO_TTL="$ASTERISM/docs/demo/data/starrydata-demo.ttl"
IMAGE="ghcr.io/oxigraph/oxigraph:latest"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

[ -f "$DEMO_TTL" ] || { echo "asterism のデモデータが無い: $DEMO_TTL" >&2; exit 1; }
[ -f data/figure-lineage.nt ] || pnpm tsx scripts/make-figure-lineage.ts

FIGURE="$(cat data/figure-lineage.leaf.txt)"

rm -rf tmp/store tmp/rdf
mkdir -p tmp/store tmp/rdf
cp "$DEMO_TTL" tmp/rdf/asterism.ttl
cp data/figure-lineage.nt tmp/rdf/provision.nt
sed "s|<FIGURE_IRI>|<${FIGURE}>|" "$QUERY" > tmp/rdf/query.rq

echo "== ストアに載せる（asterism のデモ + PROVision の図版系譜） =="
docker run --rm -v "$ROOT/tmp:/w" "$IMAGE" \
  load --location /w/store --file /w/rdf/asterism.ttl --file /w/rdf/provision.nt

echo
echo "== $QUERY =="
docker run --rm -v "$ROOT/tmp:/w" "$IMAGE" \
  query --location /w/store --query-file /w/rdf/query.rq --results-format tsv
