import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("shared avatar UI keeps a text fallback when an image is missing", () => {
  const source = readFileSync(path.join(ROOT, "public/avatar.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const avatars = context.window.JukeboxAvatars;

  assert.equal(avatars.safeUrl("/avatars/4df0d608-0131-4b94-aa39-d9a824e6a7c2.jpg"), "/avatars/4df0d608-0131-4b94-aa39-d9a824e6a7c2.jpg");
  assert.equal(avatars.safeUrl("https://attacker.example/avatar.jpg"), "");
  assert.equal(avatars.initial("  Đặng Phong "), "Đ");

  const children = [];
  let text = "";
  const element = {
    ownerDocument: {
      createElement: () => ({
        remove() {
          const index = children.indexOf(this);
          if (index >= 0) children.splice(index, 1);
        },
      }),
    },
    replaceChildren() { children.length = 0; text = ""; },
    append(child) { children.push(child); },
    get textContent() { return text; },
    set textContent(value) { text = value; },
  };
  avatars.apply(element, { avatarUrl: "/avatars/4df0d608-0131-4b94-aa39-d9a824e6a7c2.jpg", name: "Phong" });
  assert.equal(element.textContent, "");
  assert.equal(children[0].src, "/avatars/4df0d608-0131-4b94-aa39-d9a824e6a7c2.jpg");
  children[0].onerror();
  assert.equal(element.textContent, "P");
  assert.equal(children.length, 0);
});

test("avatar crop geometry covers the frame and clamps drag offsets", () => {
  const source = readFileSync(path.join(ROOT, "public/avatar-crop.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.window.JukeboxAvatarCrop.geometry({
      imageWidth: 800,
      imageHeight: 400,
      frameSize: 320,
      zoom: 1,
      offsetX: 999,
      offsetY: -999,
    }))),
    {
      scale: 0.8,
      renderedWidth: 640,
      renderedHeight: 320,
      offsetX: 160,
      offsetY: 0,
      left: 0,
      top: 0,
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.window.JukeboxAvatarCrop.geometry({
      imageWidth: 800,
      imageHeight: 400,
      frameSize: 320,
      zoom: 2,
      offsetX: 0,
      offsetY: 0,
    }))),
    {
      scale: 1.6,
      renderedWidth: 1280,
      renderedHeight: 640,
      offsetX: 0,
      offsetY: 0,
      left: -480,
      top: -160,
    }
  );
});

test("avatar crop draws the selected viewport into a square output canvas", () => {
  const source = readFileSync(path.join(ROOT, "public/avatar-crop.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const drawCalls = [];
  const drawingContext = {
    drawImage(...args) { drawCalls.push(args); },
  };
  const canvas = { width: 0, height: 0, getContext: () => drawingContext };

  context.window.JukeboxAvatarCrop.drawToCanvas(canvas, "image", {
    left: -480,
    top: -160,
    renderedWidth: 1280,
    renderedHeight: 640,
  }, 320);

  assert.equal(canvas.width, 512);
  assert.equal(canvas.height, 512);
  assert.equal(drawingContext.imageSmoothingEnabled, true);
  assert.equal(drawingContext.imageSmoothingQuality, "high");
  assert.deepEqual(drawCalls[0], ["image", -768, -256, 2048, 1024]);
});

test("member and admin pages expose avatar and search-mode controls", () => {
  const accountHtml = readFileSync(path.join(ROOT, "public/account.html"), "utf8");
  const accountJs = readFileSync(path.join(ROOT, "public/account.js"), "utf8");
  const guestJs = readFileSync(path.join(ROOT, "public/guest.js"), "utf8");
  const hostJs = readFileSync(path.join(ROOT, "public/host.js"), "utf8");
  const leaderboardJs = readFileSync(path.join(ROOT, "public/leaderboard.js"), "utf8");
  const adminHtml = readFileSync(path.join(ROOT, "public/admin.html"), "utf8");
  const adminJs = readFileSync(path.join(ROOT, "public/admin.js"), "utf8");

  assert.match(accountHtml, /id="avatar-upload"/);
  assert.match(accountJs, /\/api\/me\/avatar/);
  assert.match(guestJs, /message\.avatarUrl/);
  assert.match(guestJs, /item\.avatarUrl/);
  assert.match(hostJs, /item\.avatarUrl/);
  assert.match(leaderboardJs, /entry\.avatarUrl/);
  assert.match(adminHtml, /id="search-mode-form"/);
  assert.match(adminJs, /\/api\/admin\/search-settings/);
  assert.match(adminJs, /u\.avatarUrl/);
});
