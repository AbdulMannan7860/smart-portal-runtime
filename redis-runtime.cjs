"use strict";

const crypto = require("node:crypto");
const { createClient } = require("redis");

const GLOBAL_STATE_KEY = Symbol.for("smart-portal.redis.runtime");
const DEFAULT_PREFIX = "smart-portal:";
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2_000;

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePrefix(value) {
  const prefix = String(value || DEFAULT_PREFIX).trim() || DEFAULT_PREFIX;
  return prefix.endsWith(":") ? prefix : `${prefix}:`;
}

function getConfig() {
  return {
    enabled: parseBoolean(process.env.REDIS_ENABLED),
    host: String(process.env.REDIS_HOST || "127.0.0.1").trim(),
    port: parsePositiveInteger(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    database: Math.max(
      0,
      Number.parseInt(String(process.env.REDIS_DB || "0"), 10) || 0
    ),
    prefix: normalizePrefix(process.env.REDIS_KEY_PREFIX),
    connectTimeoutMs: parsePositiveInteger(
      process.env.REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS
    ),
    commandTimeoutMs: parsePositiveInteger(
      process.env.REDIS_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS
    ),
  };
}

function createState() {
  return {
    client: null,
    connectPromise: null,
    subscribers: new Map(),
    warnedUnavailable: false,
    lastConnectedAt: null,
    lastErrorAt: null,
    lastError: null,
  };
}

const state = globalThis[GLOBAL_STATE_KEY] || createState();
globalThis[GLOBAL_STATE_KEY] = state;

function safeErrorMessage(error) {
  const message = String(error?.message || error || "Unknown Redis error");
  return message
    .replace(/redis(s)?:\/\/[^@\s]+@/gi, "redis$1://[redacted]@")
    .slice(0, 300);
}

function recordError(error) {
  state.lastErrorAt = new Date().toISOString();
  state.lastError = safeErrorMessage(error);
  if (!state.warnedUnavailable) {
    state.warnedUnavailable = true;
    console.warn(
      "Redis is unavailable; Smart Portal is continuing without shared cache.",
      state.lastError
    );
  }
}

function commandWithTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Redis command timed out")),
        timeoutMs
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function createBaseClient(config, name) {
  const client = createClient({
    password: config.password,
    database: config.database,
    disableOfflineQueue: true,
    name,
    socket: {
      host: config.host,
      port: config.port,
      connectTimeout: config.connectTimeoutMs,
      keepAlive: true,
      reconnectStrategy(retries) {
        if (retries >= 8) return new Error("Redis reconnect limit reached");
        return Math.min(250 * 2 ** retries, 5_000);
      },
    },
  });

  client.on("error", recordError);
  client.on("ready", () => {
    state.warnedUnavailable = false;
    state.lastConnectedAt = new Date().toISOString();
    state.lastError = null;
  });
  return client;
}

async function getRedisClient() {
  const config = getConfig();
  if (!config.enabled) return null;
  if (state.client?.isReady) return state.client;
  if (state.connectPromise) return state.connectPromise;

  if (!state.client || !state.client.isOpen) {
    state.client = createBaseClient(config, "smart-portal-runtime");
  }

  state.connectPromise = commandWithTimeout(
    state.client.connect(),
    config.connectTimeoutMs + 500
  )
    .then(() => state.client)
    .catch(async (error) => {
      recordError(error);
      try {
        if (state.client?.isOpen) await state.client.close();
      } catch {
        // The connection is already unusable.
      }
      state.client = null;
      return null;
    })
    .finally(() => {
      state.connectPromise = null;
    });

  return state.connectPromise;
}

function redisKey(...parts) {
  const config = getConfig();
  const suffix = parts
    .flat()
    .filter((part) => part !== undefined && part !== null && part !== "")
    .map((part) =>
      String(part)
        .trim()
        .replace(/[\s:]+/g, "-")
        .replace(/[^a-zA-Z0-9_.-]/g, "")
        .slice(0, 180)
    )
    .filter(Boolean)
    .join(":");
  return `${config.prefix}${suffix}`;
}

async function runRedis(command) {
  const config = getConfig();
  const client = await getRedisClient();
  if (!client) return null;
  try {
    return await commandWithTimeout(
      Promise.resolve(command(client)),
      config.commandTimeoutMs
    );
  } catch (error) {
    recordError(error);
    return null;
  }
}

async function getJson(key) {
  const value = await runRedis((client) => client.get(key));
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    await runRedis((client) => client.del(key));
    return null;
  }
}

async function setJson(key, value, ttlSeconds) {
  const ttl = parsePositiveInteger(ttlSeconds, 60);
  const result = await runRedis((client) =>
    client.set(key, JSON.stringify(value), { EX: ttl })
  );
  return result === "OK";
}

async function deleteKeys(keys) {
  const normalized = [...new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean))];
  if (normalized.length === 0) return 0;
  const result = await runRedis((client) => client.del(normalized));
  return typeof result === "number" ? result : 0;
}

async function acquireLock(name, ttlMs = 30_000) {
  const key = redisKey("lock", name);
  const owner = crypto.randomUUID();
  const lockTtlMs = parsePositiveInteger(ttlMs, 30_000);
  let result = await runRedis((client) =>
    client.set(key, owner, {
      NX: true,
      PX: lockTtlMs,
    })
  );

  if (result !== "OK") {
    result = await runRedis((client) =>
      client.eval(
        "if redis.call('exists', KEYS[1]) == 1 and redis.call('pttl', KEYS[1]) == -1 then redis.call('del', KEYS[1]); return redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) else return nil end",
        {
          keys: [key],
          arguments: [owner, String(lockTtlMs)],
        }
      )
    );
  }
  return result === "OK" ? { key, owner } : null;
}

async function releaseLock(lock) {
  if (!lock?.key || !lock?.owner) return false;
  const result = await runRedis((client) =>
    client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      {
        keys: [lock.key],
        arguments: [lock.owner],
      }
    )
  );
  return result === 1;
}

async function publish(channel, payload) {
  const key = redisKey("channel", channel);
  const result = await runRedis((client) =>
    client.publish(key, JSON.stringify(payload))
  );
  return typeof result === "number";
}

async function subscribe(channel, handler) {
  const config = getConfig();
  if (!config.enabled || typeof handler !== "function") return null;
  const key = redisKey("channel", channel);
  if (state.subscribers.has(key)) return state.subscribers.get(key).unsubscribe;

  const subscriber = createBaseClient(
    config,
    `smart-portal-subscriber-${channel}`
  );
  try {
    await commandWithTimeout(
      subscriber.connect(),
      config.connectTimeoutMs + 500
    );
    await subscriber.subscribe(key, (message) => {
      try {
        handler(JSON.parse(message));
      } catch (error) {
        recordError(error);
      }
    });

    const unsubscribe = async () => {
      state.subscribers.delete(key);
      try {
        if (subscriber.isReady) await subscriber.unsubscribe(key);
        if (subscriber.isOpen) await subscriber.close();
      } catch {
        // Shutdown remains best-effort.
      }
    };
    state.subscribers.set(key, { subscriber, unsubscribe });
    return unsubscribe;
  } catch (error) {
    recordError(error);
    try {
      if (subscriber.isOpen) await subscriber.close();
    } catch {
      // The subscriber is already unavailable.
    }
    return null;
  }
}

function getRedisStatus() {
  const config = getConfig();
  return {
    enabled: config.enabled,
    connected: Boolean(state.client?.isReady),
    host: config.host,
    port: config.port,
    database: config.database,
    prefix: config.prefix,
    subscriberCount: state.subscribers.size,
    lastConnectedAt: state.lastConnectedAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
  };
}

async function closeRedis() {
  const subscriptions = [...state.subscribers.values()];
  state.subscribers.clear();
  await Promise.allSettled(
    subscriptions.map(({ unsubscribe }) => unsubscribe())
  );
  try {
    if (state.client?.isOpen) await state.client.close();
  } catch {
    // Shutdown remains best-effort.
  }
  state.client = null;
}

module.exports = {
  acquireLock,
  closeRedis,
  deleteKeys,
  getJson,
  getRedisClient,
  getRedisStatus,
  publish,
  redisKey,
  releaseLock,
  runRedis,
  setJson,
  subscribe,
};
