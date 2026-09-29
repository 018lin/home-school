const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/webm"
]);

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_URL_LENGTH = 2000000;

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return { value: "[]", items: [] };
  if (value.length > MAX_ATTACHMENTS) {
    return { error: "最多只能添加 " + MAX_ATTACHMENTS + " 个附件" };
  }
  const items = value.map(function (item) {
    const attachment = item && typeof item === "object" ? item : {};
    const type = String(attachment.type || "").trim().toLowerCase();
    const size = Number(attachment.size) || 0;
    const url = String(attachment.url || "");
    if (type && !ALLOWED_ATTACHMENT_TYPES.has(type)) {
      throw new Error("暂不支持该附件类型");
    }
    if (size < 0 || size > MAX_ATTACHMENT_BYTES) {
      throw new Error("单个附件不能超过 15MB");
    }
    if (url.length > MAX_ATTACHMENT_URL_LENGTH) {
      throw new Error("附件地址过长");
    }
    if (url && !/^data:|^https?:\/\//i.test(url)) {
      throw new Error("附件地址格式不正确");
    }
    return {
      name: String(attachment.name || "").slice(0, 80),
      type: type.slice(0, 80),
      size: size,
      url: url.slice(0, MAX_ATTACHMENT_URL_LENGTH)
    };
  });
  return { value: JSON.stringify(items), items: items };
}

module.exports = {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  normalizeAttachments
};
