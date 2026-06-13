export const TASK_STATUSES = ["todo", "doing", "review", "done"];

const TAG_PATTERN = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]{2,80})/giu;

export function parseAllowedUsers(value) {
  if (!value || !value.trim()) {
    return new Set();
  }
  return new Set(
    value
      .split(",")
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isInteger(item)),
  );
}

export function normalizeTag(tag) {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

export function extractHashtags(text) {
  const result = [];
  const seen = new Set();
  for (const match of (text || "").matchAll(TAG_PATTERN)) {
    const tag = normalizeTag(match[2]);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

export function isValidUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function commandPayload(message) {
  const text = message.text || message.caption || "";
  const parts = text.trim().split(/\s+(.+)/, 2);
  if (parts.length > 1 && parts[1].trim()) {
    return parts[1].trim();
  }

  const reply = message.reply_to_message;
  if (!reply) {
    return "";
  }
  return (reply.text || reply.caption || "").trim();
}

export function truncateText(text, maxLength = 3200) {
  if (!text || text.length <= maxLength) {
    return text || "";
  }
  return `${text.slice(0, maxLength - 1)}…`;
}
