#!/bin/bash
set -Eeuo pipefail

readonly CPANEL_USER_NAME="emaanedu"
readonly APP_ROOT="/home/${CPANEL_USER_NAME}/lms.emaan.edu.pk"
readonly RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -d "${APP_ROOT}" ]]; then
  echo "Application directory does not exist: ${APP_ROOT}"
  exit 1
fi

if [[ ! -f "${APP_ROOT}/.env.production" ]]; then
  echo "Missing ${APP_ROOT}/.env.production. Deployment stopped before changing the live application."
  exit 1
fi

for required_path in server.js realtime-protocol.cjs operations-metrics.cjs redis-runtime.cjs scripts/runtime-watchdog.sh package.json node_modules .next public; do
  if [[ ! -e "${RUNTIME_ROOT}/${required_path}" ]]; then
    echo "Runtime artifact is incomplete: missing ${required_path}"
    exit 1
  fi
done

if [[ -e "${RUNTIME_ROOT}/src" || -e "${RUNTIME_ROOT}/tests" ]]; then
  echo "Source or test files were found in the runtime repository. Deployment refused."
  exit 1
fi

echo "Publishing verified standalone runtime to ${APP_ROOT}"

# Preserve .env.production, uploads, logs, tmp, and hosting-generated files.
# Remove only application source/configuration and replaceable runtime artifacts.
for deploy_path in \
  "${APP_ROOT}/.github" \
  "${APP_ROOT}/.next" \
  "${APP_ROOT}/node_modules" \
  "${APP_ROOT}/public" \
  "${APP_ROOT}/scripts" \
  "${APP_ROOT}/src" \
  "${APP_ROOT}/tests"; do
  if [[ -e "${deploy_path}" ]]; then
    chmod -R u+rwX "${deploy_path}"
  fi
done

rm -rf \
  "${APP_ROOT}/.github" \
  "${APP_ROOT}/.next" \
  "${APP_ROOT}/node_modules" \
  "${APP_ROOT}/public" \
  "${APP_ROOT}/scripts" \
  "${APP_ROOT}/src" \
  "${APP_ROOT}/tests"

rm -f \
  "${APP_ROOT}/.cpanel.yml" \
  "${APP_ROOT}/.gitattributes" \
  "${APP_ROOT}/.gitignore" \
  "${APP_ROOT}/CPANEL_DEPLOYMENT_GUIDE.md" \
  "${APP_ROOT}/GIT_CICD_DEPLOYMENT_GUIDE.md" \
  "${APP_ROOT}/README.md" \
  "${APP_ROOT}/eslint.config.mjs" \
  "${APP_ROOT}/jsconfig.json" \
  "${APP_ROOT}/next-env.d.ts" \
  "${APP_ROOT}/next.config.mjs" \
  "${APP_ROOT}/package-lock.json" \
  "${APP_ROOT}/package.json" \
  "${APP_ROOT}/postcss.config.mjs" \
  "${APP_ROOT}/operations-metrics.cjs" \
  "${APP_ROOT}/redis-runtime.cjs" \
  "${APP_ROOT}/realtime-protocol.cjs" \
  "${APP_ROOT}/server.js" \
  "${APP_ROOT}/test-mongodb-connection.js" \
  "${APP_ROOT}/tsconfig.json" \
  "${APP_ROOT}/vercel.json"

cp -a "${RUNTIME_ROOT}/.next" "${APP_ROOT}/.next"
cp -a "${RUNTIME_ROOT}/node_modules" "${APP_ROOT}/node_modules"
cp -a "${RUNTIME_ROOT}/public" "${APP_ROOT}/public"
cp -a "${RUNTIME_ROOT}/server.js" "${APP_ROOT}/server.js"
cp -a "${RUNTIME_ROOT}/realtime-protocol.cjs" "${APP_ROOT}/realtime-protocol.cjs"
cp -a "${RUNTIME_ROOT}/operations-metrics.cjs" "${APP_ROOT}/operations-metrics.cjs"
cp -a "${RUNTIME_ROOT}/redis-runtime.cjs" "${APP_ROOT}/redis-runtime.cjs"
cp -a "${RUNTIME_ROOT}/package.json" "${APP_ROOT}/package.json"

mkdir -p "${APP_ROOT}/tmp" "${APP_ROOT}/logs" "${APP_ROOT}/scripts"
cp -a "${RUNTIME_ROOT}/scripts/runtime-watchdog.sh" "${APP_ROOT}/scripts/runtime-watchdog.sh"
chmod 755 "${APP_ROOT}/scripts/runtime-watchdog.sh"
touch "${APP_ROOT}/tmp/restart.txt"

# Keep the watchdog outside Passenger so it can recover a wedged application.
# Installation is best-effort because some shared-hosting plans hide crontab.
if command -v crontab >/dev/null 2>&1; then
  watchdog_marker="smart-portal-runtime-watchdog"
  watchdog_line="*/2 * * * * /bin/bash ${APP_ROOT}/scripts/runtime-watchdog.sh >/dev/null 2>&1 # ${watchdog_marker}"
  {
    crontab -l 2>/dev/null | grep -v "${watchdog_marker}" || true
    printf '%s\n' "${watchdog_line}"
  } | crontab - || echo "Warning: unable to install the runtime watchdog cron entry."
else
  echo "Warning: crontab is unavailable; install scripts/runtime-watchdog.sh every two minutes in cPanel."
fi

echo "Smart Portal runtime deployed successfully."
