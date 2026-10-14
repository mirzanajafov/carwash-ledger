#!/bin/sh
set -eu

BACKUPS=/backups
WITNESS=/witness
KEEP_DAYS="${KEEP_DAYS:-14}"
RUN_AT="${RUN_AT:-03:30}"

log() {
  printf '{"event":"backup","time":"%s","message":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

dump() {
  database="$1"
  stamp="$2"
  target="$BACKUPS/db/$database-$stamp.dump"
  pg_dump --format=custom --dbname="$database" --file="$target.partial"
  pg_restore --list "$target.partial" > /dev/null
  mv "$target.partial" "$target"
  log "$database $(du -h "$target" | cut -f1) $target"
}

run_once() {
  stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  mkdir -p "$BACKUPS/db" "$BACKUPS/witness"
  tar -czf "$BACKUPS/witness/witness-$stamp.tar.gz.partial" -C "$WITNESS" .
  mv "$BACKUPS/witness/witness-$stamp.tar.gz.partial" "$BACKUPS/witness/witness-$stamp.tar.gz"
  log "witness $(du -h "$BACKUPS/witness/witness-$stamp.tar.gz" | cut -f1)"
  dump ledger "$stamp"
  dump psp "$stamp"
  find "$BACKUPS/db" -name '*.dump' -mtime +"$KEEP_DAYS" -delete
  find "$BACKUPS/witness" -name 'witness-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
  date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUPS/last-success"
}

seconds_until_next_run() {
  now=$(date -u +%s)
  today=$(date -u +%Y-%m-%d)
  next=$(date -u -d "$today $RUN_AT" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

if [ "${1:-}" = "once" ]; then
  run_once
  exit
fi

log "scheduled daily at $RUN_AT UTC, keeping $KEEP_DAYS days"
while true; do
  sleep "$(seconds_until_next_run)"
  run_once || log "FAILED"
done
