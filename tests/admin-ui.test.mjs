import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function element(initial = {}) {
  const classes = new Set(initial.classes || []);
  return {
    textContent: "",
    value: "",
    disabled: false,
    focus() {},
    querySelectorAll: () => [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      },
    },
  };
}

test("admin reset action requests a new password and shows it once", async () => {
  const source = readFileSync(path.join(ROOT, "public/admin.js"), "utf8");
  const elements = {
    "reset-password-modal": element({ classes: ["hidden"] }),
    "reset-password-target": element(),
    "reset-password-value": element(),
    "reset-password-copy-btn": element(),
    "global-status": element(),
  };
  const requests = [];
  const context = {
    window: {},
    document: {
      addEventListener() {},
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
    },
    location: { hash: "" },
    history: { replaceState() {} },
    confirm: () => true,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        json: async () => ({
          ok: true,
          user: { id: "user-1", username: "member_one" },
          password: "Abcdefgh2345",
        }),
      };
    },
    setTimeout: () => 0,
    clearTimeout() {},
    console,
  };

  vm.runInNewContext(source, context);
  await context.window.resetUserPassword("user-1", "member_one");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/admin/users/user-1/reset-password");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(elements["reset-password-target"].textContent, "Tài khoản @member_one");
  assert.equal(elements["reset-password-value"].value, "Abcdefgh2345");
  assert.equal(elements["reset-password-modal"].classList.contains("hidden"), false);
});

test("admin password result can be copied to the clipboard", async () => {
  const source = readFileSync(path.join(ROOT, "public/admin.js"), "utf8");
  const passwordValue = element();
  passwordValue.value = "Abcdefgh2345";
  const copyButton = element();
  let copiedText = "";
  const context = {
    window: {},
    document: {
      addEventListener() {},
      getElementById: (id) => ({
        "reset-password-value": passwordValue,
        "reset-password-copy-btn": copyButton,
      })[id] || null,
      querySelectorAll: () => [],
    },
    navigator: {
      clipboard: {
        writeText: async (text) => { copiedText = text; },
      },
    },
    location: { hash: "" },
    history: { replaceState() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    console,
  };

  vm.runInNewContext(source, context);
  await context.window.copyResetPassword();

  assert.equal(copiedText, "Abcdefgh2345");
  assert.equal(copyButton.textContent, "Đã sao chép");
});

test("admin groups search source and order network lock under operations", () => {
  const html = readFileSync(path.join(ROOT, "public/admin.html"), "utf8");
  const source = readFileSync(path.join(ROOT, "public/admin.js"), "utf8");
  const operationsStart = html.indexOf('id="tab-operations"');
  const feedbackStart = html.indexOf('id="tab-feedback"');

  assert.ok(operationsStart >= 0);
  assert.ok(html.indexOf('id="search-mode-form"') > operationsStart);
  assert.ok(html.indexOf('id="order-network-lock-form"') > operationsStart);
  assert.ok(html.indexOf('id="search-mode-form"') < feedbackStart);
  assert.ok(html.indexOf('id="order-network-lock-form"') < feedbackStart);
  assert.match(source, /currentTab === "tab-operations"/);
});

test("admin users table merges user details, isolates streak/points, and uses action dropdown", () => {
  const html = readFileSync(path.join(ROOT, "public/admin.html"), "utf8");
  const source = readFileSync(path.join(ROOT, "public/admin.js"), "utf8");

  // Verify headers count in users table
  const userTableStart = html.indexOf('id="tab-users"');
  const userTableEnd = html.indexOf('id="tab-drops"');
  const userSectionHtml = html.slice(userTableStart, userTableEnd);

  // Checks 8 headers: Username, Vai trò, Trạng thái, Số dư điểm, Streak, Hạng hoạt động, Check-in cuối, Hành động
  const thMatches = userSectionHtml.match(/<th\b[^>]*>.*?<\/th>/gi) || [];
  assert.equal(thMatches.length, 8);
  assert.ok(!userSectionHtml.includes("<th>Tên hiển thị</th>"));
  assert.ok(userSectionHtml.includes('<th class="th-center">Số dư điểm</th>'));

  // Check search icon shell exists in tab-users
  assert.ok(userSectionHtml.includes('class="search-input-shell"'));

  // Verify source markup has user-cell with display-name and handle
  assert.match(source, /user-display-name/);
  assert.match(source, /user-handle/);
  assert.match(source, /streak-cell/);
  assert.match(source, /🔥/);
  assert.match(source, /action-menu-wrap/);
  assert.match(source, /action-menu-trigger/);
  assert.match(source, /action-dropdown/);
  assert.match(source, /action-dropdown-item is-danger/);

  // Verify dropdown uses fixed positioning in CSS to prevent clipping by table overflow
  const css = readFileSync(path.join(ROOT, "public/admin.css"), "utf8");
  assert.match(css, /\.action-dropdown\s*\{[^}]*position:\s*fixed/);

  // Verify headers bold and white styling
  assert.match(css, /\.data-table\s+th\s*\{[^}]*color:\s*#ffffff/);
  assert.match(css, /\.data-table\s+th\s*\{[^}]*font-weight:\s*800/);

  // Verify activity rank header and xp line are centered
  assert.ok(userSectionHtml.includes('<th class="th-center">Hạng hoạt động</th>'));
  assert.match(css, /\.rank-xp-line\s*\{[^}]*text-align:\s*center/);

  // Verify points column is centered
  assert.match(css, /\.points-cell\s*\{[^}]*text-align:\s*center/);

  // Verify reset password action item exists in actions dropdown
  assert.match(source, /data-action="reset">Reset mật khẩu/);

  // Verify streak only contains flame icon + number, without "ngày"
  assert.match(source, /streak-cell/);
  assert.ok(!source.includes('${Number(u.current_streak || 0)} ngày'));
  assert.ok(!source.includes('${u.current_streak} ngày'));

  // Verify action trigger has no up/down caret
  assert.ok(!source.includes("action-caret"));
});

test("admin UI includes Guest Orders tab and renders guest order items with IP address", async () => {
  const html = readFileSync(path.join(ROOT, "public/admin.html"), "utf8");
  const source = readFileSync(path.join(ROOT, "public/admin.js"), "utf8");
  const css = readFileSync(path.join(ROOT, "public/admin.css"), "utf8");

  // 1. Verify HTML tab button and panel
  assert.ok(html.includes('id="tab-btn-guest-orders"'), "Guest orders tab button must exist");
  assert.ok(html.includes('data-tab="tab-guest-orders"'));
  assert.ok(html.includes('id="tab-guest-orders"'), "Guest orders panel must exist");
  assert.ok(html.includes('id="guest-orders-search-input"'));
  assert.ok(html.includes('id="guest-orders-status-filter"'));
  assert.ok(html.includes('id="guest-orders-refresh-btn"'));
  assert.ok(html.includes('id="guest-orders-tbody"'));
  assert.ok(html.includes('id="guest-orders-pagination"'));

  // 2. Verify CSS styles for IP badge
  assert.match(css, /\.ip-badge\s*\{[^}]*font-family/);

  // 3. Verify JS rendering logic
  const tbody = element();
  tbody.innerHTML = "";
  const pagination = element();
  pagination.innerHTML = "";
  const searchInput = element();
  searchInput.value = "";
  const statusFilter = element();
  statusFilter.value = "";

  const elements = {
    "guest-orders-tbody": tbody,
    "guest-orders-pagination": pagination,
    "guest-orders-search-input": searchInput,
    "guest-orders-status-filter": statusFilter,
  };

  const requests = [];
  const context = {
    window: {},
    document: {
      addEventListener() {},
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
    },
    location: { hash: "" },
    history: { replaceState() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        json: async () => ({
          ok: true,
          total: 1,
          items: [
            {
              id: "item-1",
              title: "Guest Song Title",
              channel: "Guest Singer",
              duration: "3:45",
              thumbnail: "https://example.com/thumb.jpg",
              added_by: "Khách 123",
              requester_ip: "192.168.1.88",
              device_id: "dev-cookie-12345",
              user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
              status: "played",
              provider: "youtube",
              added_at: 1776331200000,
            },
          ],
        }),
      };
    },
    setTimeout: () => 0,
    clearTimeout() {},
    console,
  };

  vm.runInNewContext(source, context);
  await context.window.loadGuestOrders();

  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.startsWith("/api/admin/guest-orders"));
  assert.ok(tbody.innerHTML.includes("192.168.1.88"), "Rendered HTML must contain guest IP");
  assert.ok(tbody.innerHTML.includes("iPhone · Safari"), "Rendered HTML must contain parsed device info");
  assert.ok(tbody.innerHTML.includes("devcooki"), "Rendered HTML must contain short device ID");
  assert.ok(tbody.innerHTML.includes("Khách 123"), "Rendered HTML must contain guest name");
  assert.ok(tbody.innerHTML.includes("Guest Song Title"), "Rendered HTML must contain song title");
  assert.ok(tbody.innerHTML.includes("badge-played"), "Rendered HTML must contain played badge");
  assert.ok(tbody.innerHTML.includes("ip-badge"), "Rendered HTML must format IP with ip-badge class");
});


