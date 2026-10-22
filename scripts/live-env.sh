#!/bin/bash
# Source secrets for a live run without echoing them: `source scripts/live-env.sh`.
# Reads WALLET_DIR (default /workspace/crypto-earn/wallet)/tatum.env and memwal.env. Never commit those files.
W="${WALLET_DIR:-/workspace/crypto-earn/wallet}"
set -a; . "$W/tatum.env"; . "$W/memwal.env"; set +a
unset TATUM_TESTNET_API_KEY
