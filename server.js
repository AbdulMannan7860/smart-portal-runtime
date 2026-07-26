const { createServer } = require("node:http");
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
  recordRequest,
  setRealtimeConnections,
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
const realtimeClients = new Map();
const realtimeInstanceId = `${process.pid}-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;
let realtimeSequence = 0;
let unsubscribeRealtime = null;
startOperationsMetrics();

function verifyRealtimeSession(request) {
  const token = getRequestToken(request);
  if (!token || !process.env.JWT_SECRET) return null;
  const payload = verifyHs256Jwt(token, process.env.JWT_SECRET);
  const userId = payload?.impersonatedTeacherId || payload?.id;
  return userId ? { userId: String(userId) } : null;
}

function writeRealtimeEvent(response, event, data, id) {
  if (id) response.write(`id: ${id}\n`);
  if (event) response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createRealtimeChange({ method, pathname, initiatorClientId }) {
  realtimeSequence += 1;
  return {
    id: `${realtimeInstanceId}-${realtimeSequence}`,
    type: "data.changed",
    resource: resourceFromPath(pathname),
    method,
    occurredAt: new Date().toISOString(),
    initiatorClientId,
    originInstanceId: realtimeInstanceId,
  };
}

function broadcastRealtimeChange(event, { remote = false } = {}) {
  let deliveries = 0;
  for (const [clientId, client] of realtimeClients) {
    if (
      event.initiatorClientId &&
      client.clientId === event.initiatorClientId
    ) {
      continue;
    }
    try {
      writeRealtimeEvent(client.response, "data.changed", event, event.id);
      deliveries += 1;
    } catch {
      realtimeClients.delete(clientId);
      setRealtimeConnections(realtimeClients.size);
    }
  }
  recordRealtimeBroadcast({ deliveries, remote });
}

function openRealtimeStream(request, response) {
  const session = verifyRealtimeSession(request);
  if (!session) {
    response.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ error: "Authentication required" }));
    return;
  }

  const connectionsForUser = [...realtimeClients.values()].filter(
    (client) => client.userId === session.userId
  );
  if (connectionsForUser.length >= 4) {
    response.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": "10",
    });
    response.end(JSON.stringify({ error: "Too many real-time connections" }));
    return;
  }

  const browserClientId = String(request.headers["x-realtime-client"] || "").slice(0, 100);
  const clientId = `${session.userId}:${Date.now()}:${Math.random()}`;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders?.();
  response.write("retry: 3000\n\n");
  writeRealtimeEvent(response, "connected", {
    type: "connected",
    occurredAt: new Date().toISOString(),
  });

  realtimeClients.set(clientId, {
    clientId: browserClientId,
    response,
    userId: session.userId,
  });
  setRealtimeConnections(realtimeClients.size);
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25_000);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    realtimeClients.delete(clientId);
    setRealtimeConnections(realtimeClients.size);
    if (!response.writableEnded) response.end();
  };
  request.once("close", close);
  request.once("aborted", close);
}

app.prepare().then(() => {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const startedAt = process.hrtime.bigint();
    response.once("finish", () => {
      recordRequest({
        method: request.method,
        pathname: requestUrl.pathname,
        statusCode: response.statusCode,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      });
    });

    if (request.method === "GET" && requestUrl.pathname === REALTIME_PATH) {
      openRealtimeStream(request, response);
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
          const event = createRealtimeChange({
            initiatorClientId: request.headers["x-realtime-client"],
            method: request.method,
            pathname: requestUrl.pathname,
          });
          broadcastRealtimeChange(event);
          void publishRedis("realtime-data-changed", event);
        }
      });
    }

    handle(request, response);
  });

  server.listen(port, hostname, () => {
    console.log(`Smart Portal is listening on ${hostname}:${port}`);
    void subscribeRedis("realtime-data-changed", (event) => {
      if (
        event?.type === "data.changed" &&
        event.originInstanceId !== realtimeInstanceId
      ) {
        broadcastRealtimeChange(event, { remote: true });
      }
    }).then((unsubscribe) => {
      unsubscribeRealtime = unsubscribe;
    });
  });

  const shutdown = async () => {
    for (const client of realtimeClients.values()) {
      writeRealtimeEvent(client.response, "server.shutdown", {
        type: "server.shutdown",
        occurredAt: new Date().toISOString(),
      });
      client.response.end();
    }
    realtimeClients.clear();
    setRealtimeConnections(0);
    await unsubscribeRealtime?.();
    await closeRedis();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}).catch((error) => {
  console.error("Unable to start Smart Portal:", error);
  process.exit(1);
});
