const { createServer } = require("node:http");
const next = require("next");
const {
  REALTIME_PATH,
  getRequestToken,
  resourceFromPath,
  shouldBroadcastMutation,
  verifyHs256Jwt,
} = require("./realtime-protocol.cjs");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const realtimeClients = new Map();
let realtimeSequence = 0;

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

function broadcastRealtimeChange({ method, pathname, initiatorClientId }) {
  realtimeSequence += 1;
  const id = String(realtimeSequence);
  const event = {
    id,
    type: "data.changed",
    resource: resourceFromPath(pathname),
    method,
    occurredAt: new Date().toISOString(),
  };

  for (const [clientId, client] of realtimeClients) {
    if (initiatorClientId && client.clientId === initiatorClientId) continue;
    try {
      writeRealtimeEvent(client.response, "data.changed", event, id);
    } catch {
      realtimeClients.delete(clientId);
    }
  }
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
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25_000);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    realtimeClients.delete(clientId);
    if (!response.writableEnded) response.end();
  };
  request.once("close", close);
  request.once("aborted", close);
}

app.prepare().then(() => {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

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
          broadcastRealtimeChange({
            initiatorClientId: request.headers["x-realtime-client"],
            method: request.method,
            pathname: requestUrl.pathname,
          });
        }
      });
    }

    handle(request, response);
  });

  server.listen(port, hostname, () => {
    console.log(`Smart Portal is listening on ${hostname}:${port}`);
  });

  const shutdown = () => {
    for (const client of realtimeClients.values()) {
      writeRealtimeEvent(client.response, "server.shutdown", {
        type: "server.shutdown",
        occurredAt: new Date().toISOString(),
      });
      client.response.end();
    }
    realtimeClients.clear();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}).catch((error) => {
  console.error("Unable to start Smart Portal:", error);
  process.exit(1);
});
