export const TASK_STATUSES = ["todo", "doing", "review", "done"];

const TAG_PATTERN = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]{2,80})/giu;
const MENTION_PATTERN = /(^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{2,80})/g;

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

export function extractMentions(text) {
  const result = [];
  const seen = new Set();
  for (const match of (text || "").matchAll(MENTION_PATTERN)) {
    const username = match[2].toLowerCase();
    if (!seen.has(username)) {
      seen.add(username);
      result.push(username);
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

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
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

export function truncateTelegramText(text, maxLength = 3500) {
  return truncateText(text, maxLength);
}

export function appBaseUrl(env = {}) {
  return String(env.APP_BASE_URL || env.WEBHOOK_URL || "https://bot.michael.kz")
    .replace(/\/telegram\/webhook$/, "")
    .replace(/\/+$/, "");
}

export function taskWebUrl(env, projectId, taskId) {
  if (!projectId || !taskId) {
    return "";
  }
  return `${appBaseUrl(env)}/app/projects/${projectId}?task=${taskId}`;
}

export function taskWebButton(env, projectId, taskId) {
  const url = taskWebUrl(env, projectId, taskId);
  return url ? { text: "Открыть в Web", url } : null;
}
