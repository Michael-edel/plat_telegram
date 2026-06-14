import test from "node:test";
import assert from "node:assert/strict";

import { createCsrfToken, hashPassword, verifyCsrfToken, verifyPassword } from "../src/auth.js";
import { timezoneModifier } from "../src/repository.js";
import { commandPayload, extractHashtags, extractMentions, isTaskStatus, isValidUrl, parseAllowedUsers, taskWebUrl, truncateTelegramText } from "../src/utils.js";

test("extractHashtags returns unique lower-case tags", () => {
  assert.deepEqual(extractHashtags("Идея #AI #бот #ai #Бот"), ["ai", "бот"]);
});

test("isValidUrl accepts only http and https", () => {
  assert.equal(isValidUrl("https://example.com/path"), true);
  assert.equal(isValidUrl("http://localhost:8080"), true);
  assert.equal(isValidUrl("ftp://example.com"), false);
  assert.equal(isValidUrl("example.com"), false);
});

test("parseAllowedUsers parses comma-separated ids", () => {
  assert.deepEqual([...parseAllowedUsers("111, 222, bad").values()], [111, 222]);
});

test("extractMentions returns unique lower-case usernames", () => {
  assert.deepEqual(extractMentions("Привет @Michael и @alex_1, снова @michael"), ["michael", "alex_1"]);
});

test("commandPayload falls back to reply text", () => {
  assert.equal(
    commandPayload({
      text: "/idea",
      reply_to_message: { text: "Ответ с текстом" },
    }),
    "Ответ с текстом",
  );
});

test("isTaskStatus accepts only known task states", () => {
  assert.equal(isTaskStatus("todo"), true);
  assert.equal(isTaskStatus("doing"), true);
  assert.equal(isTaskStatus("review"), true);
  assert.equal(isTaskStatus("done"), true);
  assert.equal(isTaskStatus("blocked"), false);
});

test("timezoneModifier formats sqlite hour offsets", () => {
  assert.equal(timezoneModifier({ APP_TIMEZONE_OFFSET_HOURS: "5" }), "+5 hours");
  assert.equal(timezoneModifier({ APP_TIMEZONE_OFFSET_HOURS: "-3" }), "-3 hours");
  assert.equal(timezoneModifier({ APP_TIMEZONE_OFFSET_HOURS: "bad" }), "+0 hours");
});

test("taskWebUrl builds deep links from app base url", () => {
  assert.equal(taskWebUrl({ APP_BASE_URL: "https://bot.michael.kz/" }, 5, 42), "https://bot.michael.kz/app/projects/5?task=42");
});

test("truncateTelegramText uses safe telegram size", () => {
  const value = "x".repeat(3600);
  assert.equal(truncateTelegramText(value).length, 3500);
  assert.equal(truncateTelegramText(value).endsWith("…"), true);
});

test("password hashes verify only matching passwords", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(hash.startsWith("pbkdf2:sha256:"), true);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("csrf token verifies without a cookie", async () => {
  const env = { SESSION_SECRET: "test-session-secret" };
  const request = new Request("https://bot.example/login", { method: "POST" });
  const token = await createCsrfToken(env);

  assert.equal(await verifyCsrfToken(request, env, token), true);
  assert.equal(await verifyCsrfToken(request, env, "bad-token"), false);
});
