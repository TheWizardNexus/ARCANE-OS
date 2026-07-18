#!/usr/bin/env bash
set -euo pipefail

domain_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
action="${1:-issue}"
certbot_bin="${CERTBOT_BIN:-certbot}"
cert_name="precrisis.ai"
webroot="${domain_root}/public"

mapfile -t hostnames < <(node "${domain_root}/server.mjs" --list-hostnames)
if (( ${#hostnames[@]} == 0 )); then
    echo "No certificate hostnames were produced by domain.config.json." >&2
    exit 1
fi

mkdir -p "${webroot}/.well-known/acme-challenge"

case "${action}" in
    issue)
        : "${CERTBOT_EMAIL:?Set CERTBOT_EMAIL to the certificate-notice address.}"
        args=(
            certonly
            --non-interactive
            --agree-tos
            --email "${CERTBOT_EMAIL}"
            --cert-name "${cert_name}"
            --webroot
            --webroot-path "${webroot}"
            --preferred-challenges http
        )
        for hostname in "${hostnames[@]}"; do
            args+=(--domain "${hostname}")
        done
        if [[ "${CERTBOT_STAGING:-0}" == "1" ]]; then
            args+=(--dry-run)
        fi
        if [[ -n "${CERTBOT_DEPLOY_HOOK:-}" ]]; then
            args+=(--deploy-hook "${CERTBOT_DEPLOY_HOOK}")
        fi
        "${certbot_bin}" "${args[@]}"
        ;;
    renew)
        args=(renew --cert-name "${cert_name}")
        if [[ -n "${CERTBOT_DEPLOY_HOOK:-}" ]]; then
            args+=(--deploy-hook "${CERTBOT_DEPLOY_HOOK}")
        fi
        "${certbot_bin}" "${args[@]}"
        ;;
    dry-run)
        args=(renew --cert-name "${cert_name}" --dry-run)
        if [[ -n "${CERTBOT_DEPLOY_HOOK:-}" ]]; then
            args+=(--deploy-hook "${CERTBOT_DEPLOY_HOOK}" --run-deploy-hooks)
        fi
        "${certbot_bin}" "${args[@]}"
        ;;
    *)
        echo "Usage: ./certbot.sh [issue|renew|dry-run]" >&2
        exit 2
        ;;
esac
