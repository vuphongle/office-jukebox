import { scrypt, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { SessionRepository } from "./repositories/sessionRepository.js";
import { hashPassword } from "./password.js";

const SESSION_COOKIE_NAME = "jukebox_session";
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days

export { hashPassword };

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, originalHash] = storedHash.split(":");
  const expected = Buffer.from(originalHash, "utf8");
  const actual = Buffer.from(scryptSync(password, salt, 64).toString("hex"), "utf8");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPasswordAsync(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPasswordAsync(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, originalHash] = storedHash.split(":");
  const expected = Buffer.from(originalHash, "hex");
  if (!salt || expected.length !== 64) return false;
  const actual = await scryptAsync(password, salt);
  return timingSafeEqual(actual, expected);
}

export function generateSessionToken() {
  return randomBytes(32).toString("hex");
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const items = cookieHeader.split(";");
  for (const item of items) {
    const idx = item.indexOf("=");
    if (idx !== -1) {
      const key = item.slice(0, idx).trim();
      const val = item.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

export function getSessionTokenFromCookieHeader(cookieHeader) {
  return parseCookies(cookieHeader)[SESSION_COOKIE_NAME] || null;
}

export function setSessionCookie(res, token, req) {
  // Express derives `req.secure` from the configured trust-proxy policy. Do
  // not trust a caller-supplied X-Forwarded-Proto header directly.
  const isSecure = req?.secure === true;
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (isSecure) {
    cookieParts.push("Secure");
  }
  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

export function clearSessionCookie(res, req) {
  const isSecure = req?.secure === true;
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (isSecure) {
    cookieParts.push("Secure");
  }
  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

export function createAuthMiddleware(db) {
  const sessionRepo = new SessionRepository(db);

  return function authMiddleware(req, _res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    req.sessionToken = token || null;
    req.user = null;

    if (token) {
      const session = sessionRepo.findValid(token);
      if (session) {
        req.user = {
          id: session.user_id,
          username: session.username,
          displayName: session.display_name,
          role: session.role,
          status: session.status,
          pointsBalance: session.points_balance,
          currentStreak: session.current_streak,
          lastCheckinDate: session.last_checkin_date,
        };
      }
    }
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, reason: "Vui lòng đăng nhập để thực hiện tính năng này." });
  }
  if (req.user.status === "blocked") {
    return res.status(403).json({ ok: false, reason: "Tài khoản của bạn đã bị khóa." });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, reason: "Vui lòng đăng nhập tài khoản quản trị." });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ ok: false, reason: "Yêu cầu quyền Quản trị viên." });
  }
  if (req.user.status === "blocked") {
    return res.status(403).json({ ok: false, reason: "Tài khoản của bạn đã bị khóa." });
  }
  next();
}
