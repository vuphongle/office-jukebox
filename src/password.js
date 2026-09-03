import { randomBytes, scryptSync } from "node:crypto";

/** Hash a password with a per-password salt for synchronous bootstrap paths. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
