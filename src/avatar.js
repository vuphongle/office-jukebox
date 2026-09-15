const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const GENERATED_AVATAR_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;

function detectedType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", mimeType: "image/webp" };
  }
  return null;
}

export function validateAvatarUpload(buffer, contentType, { maxBytes = MAX_AVATAR_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Ảnh tải lên đang trống.");
  if (buffer.length > maxBytes) throw new Error("Ảnh đại diện không được vượt quá 5 MB.");

  const claimedType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(claimedType)) {
    throw new Error("Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.");
  }

  const detected = detectedType(buffer);
  if (!detected || detected.mimeType !== claimedType) {
    throw new Error("Định dạng ảnh không khớp với nội dung tệp.");
  }
  return detected;
}

export function avatarPublicUrl(filename) {
  return typeof filename === "string" && GENERATED_AVATAR_FILE.test(filename)
    ? `/avatars/${filename}`
    : null;
}
