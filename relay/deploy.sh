#!/usr/bin/env bash
# Deploy one relay release on the server. Run by .github/workflows/relay.yml
# after it uploads relay/ to $BASE/releases/$GIT_SHA/.
#
#   GIT_SHA=<40 hex> RELAY_HOST=relay.example.com bash deploy.sh
#
# Marks the release current only after the local HTTP check and a real
# WebSocket round trip (local and through the public hostname) pass;
# otherwise switches back to the last good image and exits 1.
set -Eeuo pipefail

BASE="${YON_RELAY_BASE:-/opt/yon-relay}" # ponytail: override only for tests
GIT_SHA="${GIT_SHA:-}"
RELAY_HOST="${RELAY_HOST:-}"

case "$GIT_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "Invalid Git SHA"; exit 1 ;;
esac
# WHY: it ends up in a URL passed to a container; host names only.
if ! printf '%s' "$RELAY_HOST" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$'; then
  echo "Invalid RELAY_HOST"; exit 1
fi

cd "$BASE/releases/$GIT_SHA"
CURRENT_SHA="$(cat "$BASE/current.tag" 2>/dev/null || true)"
ok=0

rollback() {
  [ "$ok" = 1 ] && return
  echo "Deploy of $GIT_SHA failed"
  # current.tag still names the last good release (it moves only on success).
  if [ -n "$CURRENT_SHA" ] && docker image inspect "yon-relay:$CURRENT_SHA" >/dev/null 2>&1; then
    echo "Rolling back to $CURRENT_SHA"
    YON_RELAY_TAG="$CURRENT_SHA" docker compose -f compose.yaml up -d --no-build
  else
    echo "No previous release to roll back to; yon-relay:$GIT_SHA left for debugging"
  fi
}
trap rollback EXIT

docker build \
  --label "org.opencontainers.image.title=yon-relay" \
  --label "org.opencontainers.image.revision=$GIT_SHA" \
  --tag "yon-relay:$GIT_SHA" \
  .

YON_RELAY_TAG="$GIT_SHA" docker compose -f compose.yaml up -d --no-build
sleep 3

status="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/ || true)"
case "$status" in
  404|426) echo "Local relay is reachable (HTTP $status)" ;;
  *) echo "Unexpected local relay status: $status"; exit 1 ;;
esac

# Real WebSocket round trips (/computer, /phone/<room>, 1 MiB each way),
# run from the image just built so the server needs nothing but Docker.
smoke() {
  docker run --rm --network host --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true "yon-relay:$GIT_SHA" bun check.ts "$1"
}
echo "WebSocket check, local:"
smoke ws://127.0.0.1:8787
# ws:// only for a local test run, like the app (settings.rs).
case "$RELAY_HOST" in
  localhost:* | 127.0.0.1:*) public="ws://$RELAY_HOST" ;;
  *) public="wss://$RELAY_HOST" ;;
esac
echo "WebSocket check, public ($public):"
smoke "$public"

# All checks passed: this release is now current.
if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" != "$GIT_SHA" ]; then
  # WHY: previous moves only on success, so a failed deploy can't push the
  # last good-but-one release out of the keep list below.
  docker tag "yon-relay:$CURRENT_SHA" yon-relay:previous
  printf '%s\n' "$CURRENT_SHA" > "$BASE/previous.tag"
fi
docker tag "yon-relay:$GIT_SHA" yon-relay:current
printf '%s\n' "$GIT_SHA" > "$BASE/current.tag"
ok=1
echo "Deployed yon-relay:$GIT_SHA"

# Cleanup: only the yon-relay repository and $BASE/releases. Every removal is
# printed first. Keeps current, previous and their SHA tags.
PREVIOUS_SHA="$(cat "$BASE/previous.tag" 2>/dev/null || true)"
keep() { case "$1" in current | previous | "$GIT_SHA" | "$PREVIOUS_SHA") return 0 ;; esac; return 1; }
docker image ls yon-relay --format '{{.Tag}}' | while read -r tag; do
  keep "$tag" && continue
  echo "Removing image yon-relay:$tag"
  docker image rm "yon-relay:$tag" || echo "Could not remove yon-relay:$tag"
done
for dir in "$BASE"/releases/*/; do
  name="$(basename "$dir")"
  keep "$name" && continue
  echo "Removing release directory $BASE/releases/$name"
  rm -rf -- "$BASE/releases/$name"
done
