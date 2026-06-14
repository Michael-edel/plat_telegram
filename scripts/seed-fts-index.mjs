import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const databaseName = process.env.D1_DATABASE_NAME || "plat_telegram";
const remote = process.argv.includes("--remote");
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node scripts/seed-fts-index.mjs [--remote]");
  console.log("Default mode seeds the local D1 database. Use --remote for Cloudflare D1.");
  process.exit(0);
}

const sql = `
DELETE FROM search_index;
INSERT INTO search_index (entity_type, entity_id, project_id, content)
SELECT 'task', id, project_id, text FROM tasks WHERE is_deleted = 0;
INSERT INTO search_index (entity_type, entity_id, project_id, content)
SELECT 'idea', id, project_id, text FROM ideas WHERE is_deleted = 0;
INSERT INTO search_index (entity_type, entity_id, project_id, content)
SELECT 'note', id, project_id, text FROM notes WHERE is_deleted = 0;
INSERT INTO search_index (entity_type, entity_id, project_id, content)
SELECT 'decision', id, project_id, text FROM decisions WHERE is_deleted = 0;
INSERT INTO search_index (entity_type, entity_id, project_id, content)
SELECT 'link', id, project_id, COALESCE(url, '') || ' ' || COALESCE(description, '') FROM links WHERE is_deleted = 0;
SELECT COUNT(*) AS indexed_records FROM search_index;
`;

const filePath = join(tmpdir(), `plat-telegram-seed-fts-${Date.now()}.sql`);
writeFileSync(filePath, sql, "utf8");

try {
  const args = ["wrangler", "d1", "execute", databaseName, "--file", filePath];
  if (remote) args.splice(4, 0, "--remote");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", args, { stdio: "inherit" });
} finally {
  try {
    unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
}
