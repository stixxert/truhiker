#!/usr/bin/env bash
#
# refresh-shops.sh — rebuild data/shops.osm.bin from the current Geofabrik extract.
#
# This is the build step a Workers Builds job runs (see docs/DECISIONS.md D23).
# It is written to fit that container: 2 vCPU, 8 GB RAM, 20-minute timeout, and a
# disk that is not unlimited, so the 1.38 GB PBF is downloaded to a temp path,
# used twice (two passes), and deleted in the same run.
#
#   bash tools/refresh-shops.sh            # download + build + verify
#   PBF=/tmp/norway.pbf bash tools/refresh-shops.sh   # reuse a local extract
#
set -euo pipefail

PBF="${PBF:-${TMPDIR:-/tmp}/norway-latest-$$.osm.pbf}"
SOURCE="https://download.geofabrik.de/europe/norway-latest.osm.pbf"
KEEP_PBF="${KEEP_PBF:-0}"

cleanup() {
  if [ "$KEEP_PBF" != "1" ] && [ -n "${DOWNLOADED:-}" ]; then
    rm -f "$PBF"
  fi
}
trap cleanup EXIT

if [ ! -f "$PBF" ]; then
  echo "fetch $SOURCE"
  # -L: Geofabrik redirects to a mirror. --fail: an HTML error page must not be
  # parsed as a PBF. --retry: the mirror drops connections more often than it 500s.
  curl -fL --retry 3 --retry-delay 5 --connect-timeout 30 -o "$PBF" "$SOURCE"
  DOWNLOADED=1
fi

# A truncated extract parses as "no POIs", which is the worst failure mode: the
# build would quietly ship an empty index. Pin the magnitude instead.
SIZE=$(wc -c < "$PBF" | tr -d ' ')
if [ "$SIZE" -lt 500000000 ]; then
  echo "refusing a ${SIZE}-byte extract: expected ~1.4 GB" >&2
  exit 1
fi
echo "extract: $SIZE bytes"

# --max-old-space-size is the build's own requirement (~1.4 GB across two passes);
# the container has 8 GB, so this leaves generous headroom.
#
# The provenance carries the extract date, and the binary carries none: without it
# `data/shops.osm.json` comes out undated, so neither the build's freshness check nor
# "About data" can say when the served points were taken. The mirror publishes the
# timestamp of the current extract; ask it, and pass nothing rather than a guess if it
# cannot be read (an undated provenance is honest, a fabricated date is not).
SOURCE_DATE="$(curl -fsL --connect-timeout 30 \
  "https://download.geofabrik.de/europe/norway-updates/state.txt" 2>/dev/null \
  | sed -n 's/^timestamp=\([0-9][0-9-]*\)T.*/\1/p' | head -1 || true)"
if [ -n "$SOURCE_DATE" ]; then
  echo "extract date: $SOURCE_DATE"
  node --max-old-space-size=3072 tools/build-shops.mjs --pbf "$PBF" --out data --source-date "$SOURCE_DATE"
else
  echo "extract date: unknown (state.txt unreadable) — provenance will be undated" >&2
  node --max-old-space-size=3072 tools/build-shops.mjs --pbf "$PBF" --out data
fi

# The invariants the shipped file must keep: checksum matches provenance, counts
# match, every point is in the realm, strings decode. A refresh that breaks one of
# these must fail the build rather than deploy a subtly wrong index.
node tools/inspect-shops.mjs --verify
