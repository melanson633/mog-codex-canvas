#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major > 23 || major === 22 && minor >= 18 || major === 23 && minor >= 6;
if (!supported) {
  console.error(`Unsupported Node ${process.versions.node}; need >=22.18.0 (or >=23.6.0 on Node 23).`);
  process.exit(1);
}
console.log(`[cloud-setup] Node ${process.versions.node} on ${process.platform}/${process.arch}`);
'

npm ci --include=optional --no-audit --no-fund
node --input-type=module -e "await import('@mog-sdk/sdk/node'); console.log('[cloud-setup] @mog-sdk/sdk/node loaded')"

echo "[cloud-setup] ready; run: npm run cloud:proof"
