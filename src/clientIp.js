// Resolve the client address using the same right-to-left proxy semantics as
// Express.  This helper is shared by HTTP middleware and the WebSocket upgrade
// boundary because IncomingMessage instances do not expose req.ip.

export function parseTrustProxy(value) {
  const normalized = String(value ?? "false").trim().toLowerCase();
  if (normalized === "true") return true;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return false;
}
function normalizeAddress(value) {
  return String(value || "unknown").replace(/^::ffff:/i, "") || "unknown";
}

export function getClientIp(request, trustProxy = false) {
  const remoteAddress = normalizeAddress(request?.socket?.remoteAddress || request?.connection?.remoteAddress);
  if (trustProxy === false || trustProxy === 0) return remoteAddress;

  const forwarded = String(request?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((part) => normalizeAddress(part.trim()))
    .filter((part) => part !== "unknown");
  if (!forwarded.length) return remoteAddress;

  // The chain is traversed from the app outward: socket peer, then the
  // right-most forwarded address, and so on. A numeric setting trusts exactly
  // that many hops; true trusts the whole chain and therefore requires that
  // every hop be controlled by the operator.
  if (trustProxy === true) return forwarded[0];
  const trustedHops = Math.max(0, Number(trustProxy) || 0);
  if (trustedHops === 0) return remoteAddress;
  const chain = [remoteAddress, ...forwarded.slice().reverse()];
  return chain[Math.min(trustedHops, chain.length - 1)] || remoteAddress;
}
