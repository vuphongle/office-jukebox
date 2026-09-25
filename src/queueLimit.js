import { isDedicatedMachineIp } from "./clientIp.js";

/**
 * Counts how many active songs in the queue belong to the specified requester.
 *
 * Identity isolation rules:
 * 1. userId match: same user account (when logged in).
 * 2. deviceId match: same physical device / browser (via HttpOnly 1-year cookie).
 * 3. clientId match: same browser profile (via persistent localStorage/sessionStorage).
 * 4. isDedicatedMachineIp: only applies to dedicated private workstation LAN IPs (e.g. 192.168.1.10).
 *    Public Wi-Fi IPs (NAT) and proxy loopback IPs (127.0.0.1) are NEVER treated as dedicated machine IPs,
 *    ensuring that colleagues sharing the same company Wi-Fi network are never blocked by each other.
 */
export function countUserQueuedSongs(queue, { userId, deviceId, clientId, requesterIp } = {}) {
  if (!Array.isArray(queue) || queue.length === 0) return 0;
  let count = 0;
  const isDedicated = isDedicatedMachineIp(requesterIp);

  for (const item of queue) {
    let match = false;
    if (userId && item.addedByUserId && item.addedByUserId === userId) {
      match = true;
    } else if (deviceId && item.deviceId && item.deviceId === deviceId) {
      match = true;
    } else if (clientId && item.requesterId && item.requesterId === clientId) {
      match = true;
    } else if (isDedicated && item.requesterIp && item.requesterIp === requesterIp) {
      match = true;
    }
    if (match) count++;
  }
  return count;
}
