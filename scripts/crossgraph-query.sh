#!/usr/bin/env bash
# PROVision の図版グラフと asterism の測定データを 1 つのストアに載せ、
# 横断クエリを流す。サーバは立てない（oxigraph の load / query を 1 発ずつ使う）。
#
#   scripts/crossgraph-query.sh queries/figure-to-data.rq [グラフの接頭辞] [asterism のクローン先]
#
# グラフの接頭辞は data/run/lineage（実生成）か data/figure-lineage（合成）。
# <接頭辞>.nt と <接頭辞>.leaf.txt を読む。
#
# 前提: docker が動いていること。asterism のデモデータ
#   docs/demo/data/starrydata-demo.ttl を読む。
set -euo pipefail

QUERY="${1:-queries/figure-to-data.rq}"
GRAPH="${2:-data/figure-lineage}"
ASTERISM="${3:-$HOME/develop/asterism}"
DEMO_TTL="$ASTERISM/docs/demo/data/starrydata-demo.ttl"
IMAGE="ghcr.io/oxigraph/oxigraph:latest"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

[ -f "$DEMO_TTL" ] || { echo "asterism のデモデータが無い: $DEMO_TTL" >&2; exit 1; }
[ -f "$GRAPH.nt" ] || { echo "グラフが無い: $GRAPH.nt" >&2; exit 1; }

FIGURE="$(cat "$GRAPH.leaf.txt")"

rm -rf tmp/store tmp/rdf
mkdir -p tmp/store tmp/rdf
cp "$DEMO_TTL" tmp/rdf/asterism.ttl
cp "$GRAPH.nt" tmp/rdf/provision.nt
sed "s|<FIGURE_IRI>|<${FIGURE}>|" "$QUERY" > tmp/rdf/query.rq

echo "== ストアに載せる（asterism のデモ + PROVision の図版系譜） =="
docker run --rm -v "$ROOT/tmp:/w" "$IMAGE" \
  load --location /w/store --file /w/rdf/asterism.ttl --file /w/rdf/provision.nt

echo
echo "== $QUERY （$GRAPH） =="
docker run --rm -v "$ROOT/tmp:/w" "$IMAGE" \
  query --location /w/store --query-file /w/rdf/query.rq --results-format tsv
