const DEFAULT_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function configuredOrigins(environment = process.env) {
  return String(environment.MOBILE_APP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isPrivateDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    if (!DEFAULT_ALLOWED_PROTOCOLS.has(url.protocol)) return false;

    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      /^10(?:\.\d{1,3}){3}$/.test(url.hostname) ||
      /^192\.168(?:\.\d{1,3}){2}$/.test(url.hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function resolveMobileApiCors(origin, environment = process.env) {
  const requestOrigin = String(origin || "").trim();
  if (!requestOrigin) return { allowed: true, allowOrigin: "" };

  const allowed =
    configuredOrigins(environment).includes(requestOrigin) ||
    isPrivateDevelopmentOrigin(requestOrigin);

  return {
    allowed,
    allowOrigin: allowed ? requestOrigin : "",
  };
}

function mobileApiCorsHeaders(origin, environment = process.env) {
  const { allowed, allowOrigin } = resolveMobileApiCors(origin, environment);
  if (!allowed || !allowOrigin) return {};

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-Realtime-Client",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

module.exports = {
  configuredOrigins,
  isPrivateDevelopmentOrigin,
  mobileApiCorsHeaders,
  resolveMobileApiCors,
};
