#!/bin/sh
set -e

# ─── GCP Service Account Key ──────────────────────────────────────────────────
# On ECS there is no filesystem to mount a JSON file.
# The service account JSON is base64-encoded and stored as an env var.
# At startup we decode it to a temp file and point GOOGLE_APPLICATION_CREDENTIALS to it.
# If GCP_SERVICE_ACCOUNT_B64 is not set, Google STT is skipped and Whisper is used as fallback.

if [ -n "$GCP_SERVICE_ACCOUNT_B64" ]; then
    echo "$GCP_SERVICE_ACCOUNT_B64" | base64 -d > /tmp/gcp-key.json
    export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json
    echo "[entrypoint] GCP credentials written to /tmp/gcp-key.json"
else
    echo "[entrypoint] GCP_SERVICE_ACCOUNT_B64 not set — Google STT disabled, Whisper fallback active"
fi

# ─── Start application ────────────────────────────────────────────────────────
exec node dist/main.js