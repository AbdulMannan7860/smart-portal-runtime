const { createHmac, timingSafeEqual } = require("node:crypto");

const REALTIME_PATH = "/api/realtime/events";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXCLUDED_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
]);

function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, item) => {
    const separator = item.indexOf("=");
    if (separator < 0) return cookies;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) cookies[name] = decodeCookieValue(value);
    return cookies;
  }, {});
}

function getRequestToken(request) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  return parseCookies(request.headers.cookie).jwt || null;
}

function verifyHs256Jwt(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!token || !secret) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "HS256") return null;

    const expected = createHmac("sha256", secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest();
    const received = Buffer.from(parts[2], "base64url");
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    if (payload.exp != null && Number(payload.exp) <= nowSeconds) return null;
    if (payload.nbf != null && Number(payload.nbf) > nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

function shouldBroadcastMutation(method, pathname, statusCode) {
  return (
    MUTATING_METHODS.has(method) &&
    pathname.startsWith("/api/") &&
    !EXCLUDED_PATHS.has(pathname) &&
    statusCode >= 200 &&
    statusCode < 400
  );
}

function resourceFromPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[1] === "admin-apis" && segments[2] === "answer-query-by-id") {
    return "query";
  }
  return segments[1] || "application";
}

module.exports = {
  REALTIME_PATH,
  getRequestToken,
  parseCookies,
  resourceFromPath,
  shouldBroadcastMutation,
  verifyHs256Jwt,
};
