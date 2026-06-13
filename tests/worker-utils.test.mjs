import test from "node:test";
import assert from "node:assert/strict";

import { commandPayload, extractHashtags, isValidUrl, parseAllowedUsers } from "../src/utils.js";

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

test("commandPayload falls back to reply text", () => {
  assert.equal(
    commandPayload({
      text: "/idea",
      reply_to_message: { text: "Ответ с текстом" },
    }),
    "Ответ с текстом",
  );
});
