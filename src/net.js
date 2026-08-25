import os from "node:os";

// Chọn địa chỉ IPv4 LAN có khả năng cao nhất để khách kết nối tới máy này.
// Lọc các địa chỉ IPv4 không nội bộ trong dải riêng tư và ưu tiên tên interface
// Wi-Fi/Ethernet phổ biến hơn interface ảo (VPN, Docker, vEthernet).
export function detectLanIp(override) {
  if (override) return override;

  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!isPrivate(a.address)) continue;
      candidates.push({ name, address: a.address });
    }
  }

  if (candidates.length === 0) return "127.0.0.1";

  const score = (name) => {
    const n = name.toLowerCase();
    if (/(docker|veth|vmnet|vboxnet|bridge|tun|tap|utun|llw|awdl)/.test(n)) return -1; // ảo/VPN
    if (/^en0|wlan0|wi-?fi|wlp/.test(n)) return 2; // Wi-Fi chính
    if (/^en\d|eth\d|enp/.test(n)) return 1; // Ethernet
    return 0;
  };

  candidates.sort((a, b) => score(b.name) - score(a.name));
  return candidates[0].address;
}

function isPrivate(ip) {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}
