#!/bin/bash
set -u

readonly APP_ROOT="/home/emaanedu/lms.emaan.edu.pk"
readonly STATE_DIR="${APP_ROOT}/tmp"
readonly LOG_DIR="${APP_ROOT}/logs"
readonly FAILURE_FILE="${STATE_DIR}/runtime-watchdog-failures"
readonly RESTART_FILE="${STATE_DIR}/runtime-watchdog-last-restart"
readonly LOG_FILE="${LOG_DIR}/runtime-watchdog.log"
readonly LIVE_URL="https://lms.emaan.edu.pk/api/health/live"
readonly READY_URL="https://lms.emaan.edu.pk/api/health/ready"
readonly MAX_FAILURES=3
readonly RESTART_COOLDOWN_SECONDS=1800

mkdir -p "${STATE_DIR}" "${LOG_DIR}"

log_event() {
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1" >> "${LOG_FILE}"
}

read_number() {
  local file="$1"
  local fallback="$2"
  local value
  value=$(cat "${file}" 2>/dev/null || true)
  if [[ "${value}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${value}"
  else
    printf '%s' "${fallback}"
  fi
}

failure_reason=""
if ! curl --fail --silent --show-error --max-time 12 "${LIVE_URL}" >/dev/null 2>&1; then
  failure_reason="node_liveness_failed"
elif ! curl --fail --silent --show-error --max-time 12 "${READY_URL}" >/dev/null 2>&1; then
  failure_reason="database_readiness_failed"
fi

if [[ -z "${failure_reason}" ]]; then
  previous_failures=$(read_number "${FAILURE_FILE}" 0)
  if (( previous_failures > 0 )); then
    log_event "recovered after ${previous_failures} failed checks"
  fi
  printf '0' > "${FAILURE_FILE}"
  exit 0
fi

failures=$(read_number "${FAILURE_FILE}" 0)
failures=$((failures + 1))
printf '%s' "${failures}" > "${FAILURE_FILE}"
log_event "${failure_reason} consecutive_failures=${failures}"

if (( failures < MAX_FAILURES )); then
  exit 0
fi

now=$(date +%s)
last_restart=$(read_number "${RESTART_FILE}" 0)
if (( now - last_restart < RESTART_COOLDOWN_SECONDS )); then
  log_event "restart skipped because the 30-minute cooldown is active"
  exit 0
fi

touch "${APP_ROOT}/tmp/restart.txt"
printf '%s' "${now}" > "${RESTART_FILE}"
printf '0' > "${FAILURE_FILE}"
log_event "Passenger restart requested after ${MAX_FAILURES} failed checks"

