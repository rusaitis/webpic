#!/usr/bin/env sh
# Generate local TLS certs for `npm run dev:lan` (WebGPU + crossOriginIsolated
# need a secure context, so LAN devices like an iPad require HTTPS).
set -eu
cd "$(dirname "$0")/.."

command -v mkcert >/dev/null 2>&1 || {
  echo "mkcert not found — brew install mkcert" >&2
  exit 1
}

bonjour="$(scutil --get LocalHostName).local"
lan_ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

mkdir -p .certs
# shellcheck disable=SC2086 — lan_ip is intentionally word-split (empty → omitted)
mkcert -cert-file .certs/cert.pem -key-file .certs/key.pem \
  localhost 127.0.0.1 ::1 "$bonjour" ${lan_ip:-}

echo
echo "Certs written to .certs/ — valid for: localhost, $bonjour${lan_ip:+, $lan_ip}"
echo
echo "iPad one-time setup:"
echo "  1. AirDrop $(mkcert -CAROOT)/rootCA.pem to the iPad"
echo "  2. Settings > General > VPN & Device Management > install the profile"
echo "  3. Settings > General > About > Certificate Trust Settings > enable full trust"
echo
echo "Then: npm run dev:lan  and open  https://$bonjour:5173  on the iPad."
