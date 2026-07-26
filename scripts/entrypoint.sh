#!/usr/bin/env bash
set -euo pipefail

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1365x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
fi

if [ "${POSTER_ENABLE_VNC:-false}" = "true" ]; then
  vnc_password="${POSTER_VNC_PASSWORD:-}"
  if [ -z "$vnc_password" ]; then
    echo "POSTER_VNC_PASSWORD is required while POSTER_ENABLE_VNC=true" >&2
    exit 1
  fi
  x11vnc -storepasswd "$vnc_password" /tmp/x11vnc.pass >/dev/null
  x11vnc -display :99 -forever -shared -rfbauth /tmp/x11vnc.pass -localhost >/tmp/x11vnc.log 2>&1 &
  websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
fi

unset POSTER_VNC_PASSWORD

exec "$@"
