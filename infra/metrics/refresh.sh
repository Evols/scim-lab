#!/bin/sh
set -eu

interval=${METRICS_REFRESH_INTERVAL_SECONDS:-900}
case "$interval" in
  ''|*[!0-9]*) echo 'METRICS_REFRESH_INTERVAL_SECONDS must be a positive integer' >&2; exit 1 ;;
esac
if [ "$interval" -lt 1 ]; then
  echo 'METRICS_REFRESH_INTERVAL_SECONDS must be a positive integer' >&2
  exit 1
fi

trap 'exit 0' INT TERM
while :; do
  if psql --no-psqlrc --set=ON_ERROR_STOP=1 --file=/opt/metrics/refresh.sql; then
    echo 'Metrics refresh cycle finished.'
  else
    echo 'Metrics refresh failed; retaining the previous snapshot and retrying after the interval.' >&2
  fi
  sleep "$interval" &
  wait $!
done
