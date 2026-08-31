const { monitorEventLoopDelay } = require("node:perf_hooks");

const GLOBAL_KEY = "__smartPortalOperationsMetrics";
const SAMPLE_WINDOW_MS = 5 * 60 * 1000;
const MAX_SAMPLES = 5_000;
const MAX_ERRORS = 25;

function createState() {
  return {
    startedAt: Date.now(),
    requestSamples: [],
    recentErrors: [],
    totalRequests: 0,
    statusCounts: { success: 0, redirect: 0, clientError: 0, serverError: 0 },
    realtimeConnections: 0,
    realtimeEvents: 0,
    realtimeDeliveries: 0,
    realtimePolls: 0,
    realtimeRemoteEvents: 0,
    lastRealtimeEventAt: null,
    eventLoopHistogram: null,
    lastPrunedAt: 0,
    lastCpuUsage: process.cpuUsage(),
    lastCpuMeasuredAt: process.hrtime.bigint(),
  };
}

const state = globalThis[GLOBAL_KEY] || createState();
globalThis[GLOBAL_KEY] = state;

function startOperationsMetrics() {
  if (state.eventLoopHistogram) return;
  state.eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  state.eventLoopHistogram.enable();
}

function classifyStatus(statusCode) {
  if (statusCode >= 500) return "serverError";
  if (statusCode >= 400) return "clientError";
  if (statusCode >= 300) return "redirect";
  return "success";
}

function pruneSamples(now = Date.now()) {
  if (
    state.requestSamples.length <= MAX_SAMPLES &&
    now - state.lastPrunedAt < 5_000
  ) {
    return;
  }
  const cutoff = now - SAMPLE_WINDOW_MS;
  state.requestSamples = state.requestSamples
    .filter((sample) => sample.at >= cutoff)
    .slice(-MAX_SAMPLES);
  state.recentErrors = state.recentErrors
    .filter((sample) => sample.at >= cutoff)
    .slice(-MAX_ERRORS);
  state.lastPrunedAt = now;
}

function recordRequest({ method, pathname, statusCode, durationMs }) {
  const now = Date.now();
  const sample = {
    at: now,
    method: String(method || "GET").slice(0, 10),
    pathname: String(pathname || "/").slice(0, 180),
    statusCode: Number(statusCode) || 0,
    durationMs: Math.max(0, Number(durationMs) || 0),
  };
  state.totalRequests += 1;
  state.statusCounts[classifyStatus(sample.statusCode)] += 1;
  state.requestSamples.push(sample);
  if (sample.statusCode >= 500) state.recentErrors.push(sample);
  if (
    state.requestSamples.length > MAX_SAMPLES ||
    state.recentErrors.length > MAX_ERRORS ||
    now - state.lastPrunedAt >= 5_000
  ) {
    pruneSamples(now);
  }
}

function setRealtimeConnections(count) {
  state.realtimeConnections = Math.max(0, Number(count) || 0);
}

function recordRealtimeBroadcast({ deliveries = 0, remote = false } = {}) {
  state.realtimeEvents = (state.realtimeEvents || 0) + 1;
  state.realtimeDeliveries =
    (state.realtimeDeliveries || 0) + Math.max(0, Number(deliveries) || 0);
  if (remote) {
    state.realtimeRemoteEvents = (state.realtimeRemoteEvents || 0) + 1;
  }
  state.lastRealtimeEventAt = Date.now();
}

function recordRealtimePoll({ deliveries = 0 } = {}) {
  state.realtimePolls = (state.realtimePolls || 0) + 1;
  state.realtimeDeliveries =
    (state.realtimeDeliveries || 0) + Math.max(0, Number(deliveries) || 0);
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index];
}

function measureCpuPercent() {
  const now = process.hrtime.bigint();
  const elapsedMicros = Number(now - state.lastCpuMeasuredAt) / 1_000;
  const usage = process.cpuUsage(state.lastCpuUsage);
  state.lastCpuUsage = process.cpuUsage();
  state.lastCpuMeasuredAt = now;
  if (elapsedMicros <= 0) return 0;
  return Math.min(100, ((usage.user + usage.system) / elapsedMicros) * 100);
}

function getOperationsSnapshot() {
  const now = Date.now();
  pruneSamples(now);
  const durations = state.requestSamples.map((sample) => sample.durationMs);
  const requests = state.requestSamples.length;
  const serverErrors = state.requestSamples.filter(
    (sample) => sample.statusCode >= 500
  ).length;
  const memory = process.memoryUsage();
  const histogram = state.eventLoopHistogram;
  const eventLoopP95Ms =
    histogram && Number.isFinite(histogram.percentile(95))
      ? histogram.percentile(95) / 1_000_000
      : 0;
  histogram?.reset();

  return {
    collectedAt: new Date(now).toISOString(),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      cpuPercent: Number(measureCpuPercent().toFixed(2)),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      eventLoopP95Ms: Number(eventLoopP95Ms.toFixed(2)),
    },
    traffic: {
      windowMinutes: SAMPLE_WINDOW_MS / 60_000,
      requests,
      requestsPerMinute: Number(
        (requests / (SAMPLE_WINDOW_MS / 60_000)).toFixed(2)
      ),
      averageResponseMs: Number(
        (durations.length
          ? durations.reduce((total, value) => total + value, 0) /
            durations.length
          : 0
        ).toFixed(2)
      ),
      p95ResponseMs: Number(percentile(durations, 0.95).toFixed(2)),
      p99ResponseMs: Number(percentile(durations, 0.99).toFixed(2)),
      serverErrorRatePercent: Number(
        (requests ? (serverErrors / requests) * 100 : 0).toFixed(2)
      ),
      totalSinceStart: state.totalRequests,
      statusCounts: { ...state.statusCounts },
      recentErrors: state.recentErrors.map((sample) => ({
        ...sample,
        at: new Date(sample.at).toISOString(),
      })),
    },
    realtime: {
      transport: "short-poll",
      activeConnections: state.realtimeConnections,
      pollsSinceStart: state.realtimePolls || 0,
      eventsSinceStart: state.realtimeEvents || 0,
      deliveriesSinceStart: state.realtimeDeliveries || 0,
      remoteEventsSinceStart: state.realtimeRemoteEvents || 0,
      lastEventAt: state.lastRealtimeEventAt
        ? new Date(state.lastRealtimeEventAt).toISOString()
        : null,
    },
  };
}

module.exports = {
  getOperationsSnapshot,
  recordRealtimeBroadcast,
  recordRealtimePoll,
  recordRequest,
  setRealtimeConnections,
  startOperationsMetrics,
};
