import test from "node:test";
import assert from "node:assert/strict";

import { createCsrfToken, hashPassword, verifyCsrfToken, verifyPassword } from "../src/auth.js";
import { timezoneModifier } from "../src/repository.js";
import { commandPayload, extractHashtags, extractMentions, isTaskStatus, isValidUrl, parseAllowedUsers, taskWebUrl, truncateTelegramText } from "../src/utils.js";
import { canTelegramWrite, classifyTelegramIntake, parseEntityActionCallback } from "../src/worker.js";
import { handleOneCWebhook, validateOneCEnvelope, validateOneCTaskPayload } from "../src/web.js";

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

test("parseEntityActionCallback accepts only known inline entity actions", () => {
  assert.deepEqual(parseEntityActionCallback("convert_to_task:idea:12"), { action: "convert_to_task", entityType: "idea", entityId: 12 });
  assert.deepEqual(parseEntityActionCallback("convert_to_task:link:7"), { action: "convert_to_task", entityType: "link", entityId: 7 });
  assert.deepEqual(parseEntityActionCallback("archive_entity:idea:3"), { action: "archive_entity", entityType: "idea", entityId: 3 });
  assert.deepEqual(parseEntityActionCallback("archive_entity:link:4"), { action: "archive_entity", entityType: "link", entityId: 4 });
  assert.equal(parseEntityActionCallback("archive_entity:note:4"), null);
  assert.equal(parseEntityActionCallback("convert_to_task:idea:0"), null);
  assert.equal(parseEntityActionCallback("convert_to_task:idea:bad"), null);
});

test("classifyTelegramIntake routes free text into project folders", () => {
  assert.deepEqual(classifyTelegramIntake("https://example.com описание"), { type: "link", url: "https://example.com", description: "описание" });
  assert.deepEqual(classifyTelegramIntake("идея: сделать авторазбор"), { type: "idea", text: "сделать авторазбор" });
  assert.deepEqual(classifyTelegramIntake("задача проверить webhook"), { type: "task", text: "проверить webhook" });
  assert.deepEqual(classifyTelegramIntake("решение: используем Cloudflare"), { type: "decision", text: "используем Cloudflare" });
  assert.deepEqual(classifyTelegramIntake("заметка: обсудить позже"), { type: "note", text: "обсудить позже" });
  assert.deepEqual(classifyTelegramIntake("просто информация"), { type: "note", text: "просто информация" });
  assert.equal(classifyTelegramIntake("   "), null);
});

test("viewer cannot perform Telegram write callbacks", () => {
  assert.equal(canTelegramWrite({ is_active: 1, role: "admin" }), true);
  assert.equal(canTelegramWrite({ is_active: 1, role: "manager" }), true);
  assert.equal(canTelegramWrite({ is_active: 1, role: "editor" }), true);
  assert.equal(canTelegramWrite({ is_active: 1, role: "viewer" }), false);
  assert.equal(canTelegramWrite({ is_active: 0, role: "admin" }), false);
});

test("1C webhook validation rejects malformed envelopes and tag payloads", () => {
  assert.equal(validateOneCEnvelope({ event_id: "short", event_type: "task_created", payload: {} }).error, "event_id must be 8..128 characters");
  assert.equal(validateOneCEnvelope({ event_id: "event-0001", event_type: "task_created", payload: [] }).error, "payload object is required");
  assert.equal(validateOneCTaskPayload({ text: "" }), "payload.text is required");
  assert.equal(validateOneCTaskPayload({ text: "task", tags: "bad" }), "payload.tags must be an array");
  assert.equal(validateOneCTaskPayload({ text: "task", tags: ["ok", 123] }), "payload.tags must contain only strings");
  assert.equal(validateOneCTaskPayload({ text: "task", tags: ["ok"] }), "");
});

test("1C webhook returns controlled config/auth/json errors", async () => {
  const noToken = await handleOneCWebhook({}, new Request("https://bot.example/api/webhooks/1c-events", { method: "POST", body: "{}" }));
  assert.equal(noToken.status, 503);

  const wrongToken = await handleOneCWebhook(
    { ONE_C_WEBHOOK_TOKEN: "secret" },
    new Request("https://bot.example/api/webhooks/1c-events", {
      method: "POST",
      headers: { "X-1C-Webhook-Token": "wrong" },
      body: "{}",
    }),
  );
  assert.equal(wrongToken.status, 401);

  const invalidJson = await handleOneCWebhook(
    { ONE_C_WEBHOOK_TOKEN: "secret" },
    new Request("https://bot.example/api/webhooks/1c-events", {
      method: "POST",
      headers: { "X-1C-Webhook-Token": "secret" },
      body: "{bad",
    }),
  );
  assert.equal(invalidJson.status, 400);
});

function mockD1WithProcessedEvent(event) {
  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO processed_1c_events")) {
                return { meta: { changes: 0, rows_written: 0 } };
              }
              return { meta: { changes: 1, rows_written: 1 } };
            },
            async first() {
              if (sql.includes("SELECT event_id, entity_type, entity_id, status")) {
                return event;
              }
              throw new Error(`Unexpected first SQL: ${sql} ${bindings.join(",")}`);
            },
          };
        },
      };
    },
  };
}

test("1C webhook duplicate processed and failed events are idempotent", async () => {
  const body = JSON.stringify({ event_id: "event-0001", event_type: "task_created", project_id: 1, payload: { text: "task" } });
  const processed = await handleOneCWebhook(
    { ONE_C_WEBHOOK_TOKEN: "secret", DB: mockD1WithProcessedEvent({ status: "processed", entity_type: "task", entity_id: 42 }) },
    new Request("https://bot.example/api/webhooks/1c-events", { method: "POST", headers: { "X-1C-Webhook-Token": "secret" }, body }),
  );
  assert.equal(processed.status, 200);
  assert.equal((await processed.json()).task_id, 42);

  const failed = await handleOneCWebhook(
    { ONE_C_WEBHOOK_TOKEN: "secret", DB: mockD1WithProcessedEvent({ status: "failed", error_message: "Project not found" }) },
    new Request("https://bot.example/api/webhooks/1c-events", { method: "POST", headers: { "X-1C-Webhook-Token": "secret" }, body }),
  );
  assert.equal(failed.status, 409);
});
