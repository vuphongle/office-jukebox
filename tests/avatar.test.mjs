import test from "node:test";
import assert from "node:assert/strict";

import { avatarPublicUrl, validateAvatarUpload } from "../src/avatar.js";

test("avatar upload accepts matching JPEG, PNG, and WebP signatures", () => {
  assert.deepEqual(validateAvatarUpload(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"), {
    extension: "jpg",
    mimeType: "image/jpeg",
  });
  assert.deepEqual(
    validateAvatarUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"),
    { extension: "png", mimeType: "image/png" }
  );
  assert.deepEqual(validateAvatarUpload(Buffer.from("RIFF1234WEBP"), "image/webp"), {
    extension: "webp",
    mimeType: "image/webp",
  });
});

test("avatar upload rejects empty, oversized, SVG, and mismatched content", () => {
  assert.throws(() => validateAvatarUpload(Buffer.alloc(0), "image/jpeg"), /trống/i);
  assert.throws(() => validateAvatarUpload(Buffer.alloc(11), "image/jpeg", { maxBytes: 10 }), /5 MB/i);
  assert.throws(() => validateAvatarUpload(Buffer.from("<svg></svg>"), "image/svg+xml"), /JPEG, PNG hoặc WebP/i);
  assert.throws(() => validateAvatarUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/jpeg"), /không khớp/i);
});

test("avatar public URL only accepts generated avatar filenames", () => {
  assert.equal(avatarPublicUrl("4df0d608-0131-4b94-aa39-d9a824e6a7c2.jpg"), "/avatars/4df0d608-0131-4b94-aa39-d9a824e6a7c2.jpg");
  assert.equal(avatarPublicUrl("../../settings.json"), null);
  assert.equal(avatarPublicUrl("avatar.svg"), null);
  assert.equal(avatarPublicUrl(null), null);
});
