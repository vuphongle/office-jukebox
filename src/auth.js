import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { UserRepository } from "./repositories/userRepository.js";
import { SessionRepository } from "./repositories/sessionRepository.js";

const SESSION_COOKIE_NAME = "jukebox_session";
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, originalHash] = storedHash.split(":");
  const testHash = scryptSync(password, salt, 64).toString("hex");
  return timingSafeEqual(Buffer.from(testHash, "utf8"), Buffer.from(originalHash, "utf8"));
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

export function setSessionCookie(res, token, req) {
  const isSecure = req?.secure || req?.headers?.["x-forwarded-proto"] === "https";
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
  const isSecure = req?.secure || req?.headers?.["x-forwarded-proto"] === "https";
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
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ ok: false, reason: "Yêu cầu quyền Quản trị viên." });
  }
  if (req.user.status === "blocked") {
    return res.status(403).json({ ok: false, reason: "Tài khoản của bạn đã bị khóa." });
  }
  next();
}
