const { createServer } = require("node:http");
const { appendFile, mkdirSync, statSync, renameSync } = require("node:fs");
const path = require("node:path");
const next = require("next");
const {
  REALTIME_PATH,
  getRequestToken,
  resourceFromPath,
  shouldBroadcastMutation,
  verifyHs256Jwt,
} = require("./realtime-protocol.cjs");
const {
  recordRealtimeBroadcast,
  recordRealtimePoll,
  recordRequest,
  startOperationsMetrics,
} = require("./operations-metrics.cjs");
const {
  closeRedis,
  publish: publishRedis,
  subscribe: subscribeRedis,
} = require("./redis-runtime.cjs");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const realtimeInstanceId = `${process.pid}-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;
let realtimeSequence = 0;
const realtimeEvents = [];
const MAX_REALTIME_EVENTS = 250;
const MAX_POLL_EVENTS = 100;
const REALTIME_POLL_INTERVAL_MS = 60_000;
const MAX_ACTIVE_API_REQUESTS = positiveInteger(
  process.env.MAX_ACTIVE_API_REQUESTS,
  24
);
const SLOW_REQUEST_MS = positiveInteger(process.env.SLOW_REQUEST_MS, 5_000);
const RUNTIME_LOG_PATH = path.resolve(
  process.env.RUNTIME_LOG_PATH || path.join(process.cwd(), "logs", "runtime-events.ndjson")
);
let unsubscribeRealtime = null;
let activeRequests = 0;
let activeApiRequests = 0;
let lastOverloadLogAt = 0;
startOperationsMetrics();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function prepareRuntimeLog() {
  try {
    mkdirSync(path.dirname(RUNTIME_LOG_PATH), { recursive: true });
    if (statSync(RUNTIME_LOG_PATH, { throwIfNoEntry: false })?.size > 5 * 1024 * 1024) {
      renameSync(RUNTIME_LOG_PATH, `${RUNTIME_LOG_PATH}.1`);
    }
  } catch (error) {
    console.warn("Unable to prepare runtime event log:", error.message);
  }
}

function logRuntimeEvent(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    ...details,
  };
  const line = `${JSON.stringify(entry)}\n`;
  if (level === "error") console.error(line.trim());
  else if (level === "warn") console.warn(line.trim());
  else console.log(line.trim());
  appendFile(RUNTIME_LOG_PATH, line, () => {});
}

prepareRuntimeLog();

function verifyRealtimeSession(request) {
  const token = getRequestToken(request);
  if (!token || !process.env.JWT_SECRET) return null;
  const payload = verifyHs256Jwt(token, process.env.JWT_SECRET);
  const userId = payload?.impersonatedTeacherId || payload?.id;
  return userId ? { userId: String(userId) } : null;
}

function createRealtimeChange({ method, pathname, initiatorClientId }) {
  return {
    id: `${realtimeInstanceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "data.changed",
    resource: resourceFromPath(pathname),
    method,
    occurredAt: new Date().toISOString(),
    initiatorClientId,
    originInstanceId: realtimeInstanceId,
  };
}

function storeRealtimeChange(event, { remote = false } = {}) {
  realtimeSequence += 1;
  const storedEvent = { ...event, sequence: realtimeSequence };
  realtimeEvents.push(storedEvent);
  if (realtimeEvents.length > MAX_REALTIME_EVENTS) realtimeEvents.shift();
  recordRealtimeBroadcast({ deliveries: 0, remote });
  return storedEvent;
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function pollRealtimeEvents(request, response, requestUrl) {
  const session = verifyRealtimeSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Authentication required" });
    return;
  }

  const requestedCursor = Number.parseInt(requestUrl.searchParams.get("after") || "", 10);
  const hasCursor = Number.isFinite(requestedCursor) && requestedCursor >= 0;
  const oldestSequence = realtimeEvents[0]?.sequence || realtimeSequence;
  const reset = hasCursor && requestedCursor > realtimeSequence;
  const events = hasCursor && !reset
    ? realtimeEvents
        .filter(
          (event) =>
            event.sequence > requestedCursor &&
            event.initiatorClientId !== request.headers["x-realtime-client"]
        )
        .slice(-MAX_POLL_EVENTS)
    : [];
  recordRealtimePoll({ deliveries: events.length });
  sendJson(response, 200, {
    cursor: realtimeSequence,
    events,
    reset: reset || (hasCursor && requestedCursor < oldestSequence - 1),
    retryAfterMs: REALTIME_POLL_INTERVAL_MS,
  });
}

app.prepare().then(() => {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const isApiRequest = requestUrl.pathname.startsWith("/api/");
    const startedAt = process.hrtime.bigint();
    let completed = false;
    const completeRequest = () => {
      if (completed) return;
      completed = true;
      activeRequests = Math.max(0, activeRequests - 1);
      if (isApiRequest) activeApiRequests = Math.max(0, activeApiRequests - 1);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      recordRequest({
        method: request.method,
        pathname: requestUrl.pathname,
        statusCode: response.statusCode,
        durationMs,
      });
      if (
        durationMs >= SLOW_REQUEST_MS ||
        (response.statusCode >= 500 && !response.smartPortalOverload)
      ) {
        logRuntimeEvent(response.statusCode >= 500 ? "error" : "warn", "request.completed", {
          method: request.method,
          pathname: requestUrl.pathname,
          statusCode: response.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
          activeRequests,
        });
      }
    };
    activeRequests += 1;
    if (isApiRequest) activeApiRequests += 1;
    response.once("finish", completeRequest);
    response.once("close", completeRequest);

    if (request.method === "GET" && requestUrl.pathname === "/api/health/live") {
      sendJson(response, 200, {
        status: "healthy",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        activeRequests,
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === REALTIME_PATH) {
      pollRealtimeEvents(request, response, requestUrl);
      return;
    }

    if (isApiRequest && activeApiRequests > MAX_ACTIVE_API_REQUESTS) {
      const now = Date.now();
      if (now - lastOverloadLogAt >= 30_000) {
        lastOverloadLogAt = now;
        logRuntimeEvent("warn", "request.overload", {
          activeApiRequests,
          maximum: MAX_ACTIVE_API_REQUESTS,
          pathname: requestUrl.pathname,
        });
      }
      response.smartPortalOverload = true;
      sendJson(
        response,
        503,
        { error: "The LMS is temporarily busy. Please retry in a few seconds." },
        { "Retry-After": "3" }
      );
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      response.once("finish", () => {
        if (
          shouldBroadcastMutation(
            request.method,
            requestUrl.pathname,
            response.statusCode
          )
        ) {
          const event = storeRealtimeChange(createRealtimeChange({
            initiatorClientId: request.headers["x-realtime-client"],
            method: request.method,
            pathname: requestUrl.pathname,
          }));
          void publishRedis("realtime-data-changed", event);
        }
      });
    }

    Promise.resolve(handle(request, response)).catch((error) => {
      logRuntimeEvent("error", "request.unhandled", {
        method: request.method,
        pathname: requestUrl.pathname,
        message: String(error?.message || error).slice(0, 500),
        stack: String(error?.stack || "").slice(0, 2_000),
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Internal server error" });
      } else if (!response.destroyed) {
        response.destroy(error);
      }
    });
  });

  server.requestTimeout = positiveInteger(process.env.HTTP_REQUEST_TIMEOUT_MS, 120_000);
  server.headersTimeout = positiveInteger(process.env.HTTP_HEADERS_TIMEOUT_MS, 30_000);
  server.keepAliveTimeout = positiveInteger(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 5_000);
  server.setTimeout(positiveInteger(process.env.HTTP_SOCKET_TIMEOUT_MS, 75_000));
  server.maxRequestsPerSocket = positiveInteger(process.env.HTTP_MAX_REQUESTS_PER_SOCKET, 100);

  server.listen(port, hostname, () => {
    logRuntimeEvent("info", "server.started", {
      hostname,
      port,
      maximumActiveApiRequests: MAX_ACTIVE_API_REQUESTS,
      realtimeTransport: "short-poll",
    });
    console.log(`Smart Portal is listening on ${hostname}:${port}`);
    void subscribeRedis("realtime-data-changed", (event) => {
      if (
        event?.type === "data.changed" &&
        event.originInstanceId !== realtimeInstanceId
      ) {
        storeRealtimeChange(event, { remote: true });
      }
    }).then((unsubscribe) => {
      unsubscribeRealtime = unsubscribe;
    });
  });

  const shutdown = async () => {
    logRuntimeEvent("info", "server.shutdown", { activeRequests });
    const forcedExit = setTimeout(() => process.exit(1), 10_000);
    forcedExit.unref?.();
    await unsubscribeRealtime?.();
    await closeRedis();
    server.close(() => {
      clearTimeout(forcedExit);
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("warning", (warning) => {
    logRuntimeEvent("warn", "process.warning", {
      name: warning.name,
      message: warning.message,
      stack: String(warning.stack || "").slice(0, 2_000),
    });
  });
  process.on("unhandledRejection", (error) => {
    logRuntimeEvent("error", "process.unhandledRejection", {
      message: String(error?.message || error).slice(0, 500),
      stack: String(error?.stack || "").slice(0, 2_000),
    });
  });
  process.on("uncaughtException", (error) => {
    logRuntimeEvent("error", "process.uncaughtException", {
      message: String(error?.message || error).slice(0, 500),
      stack: String(error?.stack || "").slice(0, 2_000),
    });
    setTimeout(() => process.exit(1), 250).unref?.();
  });
}).catch((error) => {
  console.error("Unable to start Smart Portal:", error);
  process.exit(1);
});
