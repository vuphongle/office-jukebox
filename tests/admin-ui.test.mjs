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
