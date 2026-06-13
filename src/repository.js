import { TASK_STATUSES, extractHashtags } from "./utils.js";

export const ENTITY_CONFIG = {
  ideas: { table: "ideas", entityType: "idea", label: "Идеи", single: "Идея" },
  notes: { table: "notes", entityType: "note", label: "Заметки", single: "Заметка" },
  decisions: { table: "decisions", entityType: "decision", label: "Решения", single: "Решение" },
};

export const WORK_ENTITY_TABLES = new Set(["tasks", "ideas", "notes", "decisions", "links"]);

function detailsJson(details) {
  return details ? JSON.stringify(details) : null;
}

export async function auditLog(db, { userId = null, action, entityType = null, entityId = null, details = null }) {
  await db
    .prepare(
      "INSERT INTO audit_log (user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    )
    .bind(userId, action, entityType, entityId, detailsJson(details))
    .run();
}

export async function findUserByTelegramId(db, telegramId) {
  if (!telegramId) {
    return null;
  }
  return await db
    .prepare("SELECT id, username, role, is_active FROM users WHERE telegram_id = ? AND is_active = 1")
    .bind(String(telegramId))
    .first();
}

export async function saveTags(db, entityType, entityId, text) {
  const tags = extractHashtags(text);
  for (const tag of tags) {
    const row = await db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?) RETURNING id").bind(tag).first();
    const tagRow = row || (await db.prepare("SELECT id FROM tags WHERE name = ?").bind(tag).first());
    await db
      .prepare("INSERT OR IGNORE INTO entity_tags (entity_type, entity_id, tag_id) VALUES (?, ?, ?)")
      .bind(entityType, entityId, tagRow.id)
      .run();
  }
}

export async function getOrCreateProject(db, name, userId = null, source = "web") {
  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error("Название проекта не может быть пустым");
  }

  const existing = await db.prepare("SELECT * FROM projects WHERE name = ?").bind(cleanName).first();
  if (existing) {
    return existing;
  }

  const project = await db
    .prepare("INSERT INTO projects (name, created_at) VALUES (?, datetime('now')) RETURNING *")
    .bind(cleanName)
    .first();
  await auditLog(db, {
    userId,
    action: "project.created",
    entityType: "project",
    entityId: project.id,
    details: { name: cleanName, source },
  });
  return project;
}

export async function listProjects(db) {
  const { results } = await db
    .prepare(
      `SELECT
        p.id,
        p.name,
        p.created_at,
        SUM(CASE WHEN t.status = 'todo' AND t.is_deleted = 0 THEN 1 ELSE 0 END) AS todo_count,
        SUM(CASE WHEN t.status = 'doing' AND t.is_deleted = 0 THEN 1 ELSE 0 END) AS doing_count,
        SUM(CASE WHEN t.status = 'review' AND t.is_deleted = 0 THEN 1 ELSE 0 END) AS review_count,
        SUM(CASE WHEN t.status = 'done' AND t.is_deleted = 0 THEN 1 ELSE 0 END) AS done_count,
        (SELECT COUNT(*) FROM ideas WHERE project_id = p.id AND is_deleted = 0) AS ideas_count,
        (SELECT COUNT(*) FROM notes WHERE project_id = p.id AND is_deleted = 0) AS notes_count,
        (SELECT COUNT(*) FROM decisions WHERE project_id = p.id AND is_deleted = 0) AS decisions_count,
        (SELECT COUNT(*) FROM links WHERE project_id = p.id AND is_deleted = 0) AS links_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id
      ORDER BY p.name`,
    )
    .all();
  return results;
}

export async function getProject(db, projectId) {
  return await db.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
}

function authorSelect(alias = "u") {
  return `COALESCE(${alias}.display_name, ${alias}.username, '—') AS author_name`;
}

export async function loadProjectData(db, projectId) {
  const [tasks, ideas, notes, decisions, links] = await Promise.all([
    db
      .prepare(
        `SELECT t.id, t.text, t.status, t.created_at, t.updated_at, t.author_id, ${authorSelect()}
         FROM tasks t
         LEFT JOIN users u ON u.id = t.author_id
         WHERE t.project_id = ? AND t.is_deleted = 0
         ORDER BY t.created_at DESC`,
      )
      .bind(projectId)
      .all(),
    db
      .prepare(
        `SELECT i.id, i.text, i.created_at, i.updated_at, i.author_id, ${authorSelect()}
         FROM ideas i
         LEFT JOIN users u ON u.id = i.author_id
         WHERE i.project_id = ? AND i.is_deleted = 0
         ORDER BY i.created_at DESC LIMIT 100`,
      )
      .bind(projectId)
      .all(),
    db
      .prepare(
        `SELECT n.id, n.text, n.created_at, n.updated_at, n.author_id, ${authorSelect()}
         FROM notes n
         LEFT JOIN users u ON u.id = n.author_id
         WHERE n.project_id = ? AND n.is_deleted = 0
         ORDER BY n.created_at DESC LIMIT 100`,
      )
      .bind(projectId)
      .all(),
    db
      .prepare(
        `SELECT d.id, d.text, d.created_at, d.updated_at, d.author_id, ${authorSelect()}
         FROM decisions d
         LEFT JOIN users u ON u.id = d.author_id
         WHERE d.project_id = ? AND d.is_deleted = 0
         ORDER BY d.created_at DESC LIMIT 100`,
      )
      .bind(projectId)
      .all(),
    db
      .prepare(
        `SELECT l.id, l.url, l.description, l.created_at, l.updated_at, l.author_id, ${authorSelect()}
         FROM links l
         LEFT JOIN users u ON u.id = l.author_id
         WHERE l.project_id = ? AND l.is_deleted = 0
         ORDER BY l.created_at DESC LIMIT 100`,
      )
      .bind(projectId)
      .all(),
  ]);

  return {
    tasks: tasks.results,
    ideas: ideas.results,
    notes: notes.results,
    decisions: decisions.results,
    links: links.results,
  };
}

export async function createTask(db, { projectId, text, authorId = null, source = "web" }) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст задачи не может быть пустым");
  }
  const task = await db
    .prepare(
      "INSERT INTO tasks (project_id, text, status, author_id, created_at, updated_at) VALUES (?, ?, 'todo', ?, datetime('now'), datetime('now')) RETURNING *",
    )
    .bind(projectId, cleanText, authorId)
    .first();
  await saveTags(db, "task", task.id, cleanText);
  await auditLog(db, {
    userId: authorId,
    action: "task.created",
    entityType: "task",
    entityId: task.id,
    details: { project_id: projectId, source },
  });
  return task;
}

export async function updateTaskStatus(db, { taskId, projectId, status, userId }) {
  if (!TASK_STATUSES.includes(status)) {
    throw new Error("Некорректный статус задачи");
  }

  const existing = await db
    .prepare("SELECT id, status FROM tasks WHERE id = ? AND project_id = ? AND is_deleted = 0")
    .bind(taskId, projectId)
    .first();
  if (!existing) {
    throw new Error("Задача не найдена");
  }

  await db
    .prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ? AND is_deleted = 0")
    .bind(status, taskId, projectId)
    .run();
  await auditLog(db, {
    userId,
    action: "task.status_changed",
    entityType: "task",
    entityId: taskId,
    details: { project_id: projectId, old_status: existing.status, new_status: status, source: "web" },
  });
}

export async function updateTaskText(db, { taskId, projectId, text, userId }) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст задачи не может быть пустым");
  }
  await db
    .prepare("UPDATE tasks SET text = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ? AND is_deleted = 0")
    .bind(cleanText, taskId, projectId)
    .run();
  await saveTags(db, "task", taskId, cleanText);
  await auditLog(db, {
    userId,
    action: "task.edited",
    entityType: "task",
    entityId: taskId,
    details: { project_id: projectId, source: "web" },
  });
}

export async function softDeleteTask(db, { taskId, projectId, userId }) {
  await db
    .prepare("UPDATE tasks SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND project_id = ?")
    .bind(taskId, projectId)
    .run();
  await auditLog(db, {
    userId,
    action: "task.deleted",
    entityType: "task",
    entityId: taskId,
    details: { project_id: projectId, source: "web" },
  });
}

export async function createTextEntity(db, { table, entityType, projectId, text, authorId = null, source = "web" }) {
  if (!WORK_ENTITY_TABLES.has(table) || table === "tasks" || table === "links") {
    throw new Error("Некорректный тип сущности");
  }
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст не может быть пустым");
  }

  const row = await db
    .prepare(`INSERT INTO ${table} (project_id, text, author_id, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now')) RETURNING *`)
    .bind(projectId, cleanText, authorId)
    .first();
  await saveTags(db, entityType, row.id, cleanText);
  await auditLog(db, {
    userId: authorId,
    action: `${entityType}.created`,
    entityType,
    entityId: row.id,
    details: { project_id: projectId, source },
  });
  return row;
}

export async function updateTextEntity(db, { table, entityType, entityId, projectId, text, userId }) {
  if (!WORK_ENTITY_TABLES.has(table) || table === "tasks" || table === "links") {
    throw new Error("Некорректный тип сущности");
  }
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст не может быть пустым");
  }

  await db
    .prepare(`UPDATE ${table} SET text = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ? AND is_deleted = 0`)
    .bind(cleanText, entityId, projectId)
    .run();
  await saveTags(db, entityType, entityId, cleanText);
  await auditLog(db, {
    userId,
    action: `${entityType}.edited`,
    entityType,
    entityId,
    details: { project_id: projectId, source: "web" },
  });
}

export async function softDeleteTextEntity(db, { table, entityType, entityId, projectId, userId }) {
  if (!WORK_ENTITY_TABLES.has(table) || table === "tasks" || table === "links") {
    throw new Error("Некорректный тип сущности");
  }
  await db
    .prepare(`UPDATE ${table} SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND project_id = ?`)
    .bind(entityId, projectId)
    .run();
  await auditLog(db, {
    userId,
    action: `${entityType}.deleted`,
    entityType,
    entityId,
    details: { project_id: projectId, source: "web" },
  });
}

export async function createLink(db, { projectId, url, description, authorId = null, source = "web" }) {
  const cleanUrl = url.trim();
  const cleanDescription = description.trim();
  const link = await db
    .prepare(
      "INSERT INTO links (project_id, url, description, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now')) RETURNING *",
    )
    .bind(projectId, cleanUrl, cleanDescription || null, authorId)
    .first();
  await saveTags(db, "link", link.id, `${cleanUrl} ${cleanDescription}`);
  await auditLog(db, {
    userId: authorId,
    action: "link.created",
    entityType: "link",
    entityId: link.id,
    details: { project_id: projectId, source },
  });
  return link;
}

export async function updateLink(db, { linkId, projectId, url, description, userId }) {
  const cleanUrl = url.trim();
  const cleanDescription = description.trim();
  await db
    .prepare("UPDATE links SET url = ?, description = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ? AND is_deleted = 0")
    .bind(cleanUrl, cleanDescription || null, linkId, projectId)
    .run();
  await saveTags(db, "link", linkId, `${cleanUrl} ${cleanDescription}`);
  await auditLog(db, {
    userId,
    action: "link.edited",
    entityType: "link",
    entityId: linkId,
    details: { project_id: projectId, source: "web" },
  });
}

export async function softDeleteLink(db, { linkId, projectId, userId }) {
  await db
    .prepare("UPDATE links SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND project_id = ?")
    .bind(linkId, projectId)
    .run();
  await auditLog(db, {
    userId,
    action: "link.deleted",
    entityType: "link",
    entityId: linkId,
    details: { project_id: projectId, source: "web" },
  });
}

export async function searchProject(db, projectId, query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return [];
  }

  const like = `%${cleanQuery}%`;
  const [ideas, tasks, links, notes, decisions] = await Promise.all([
    db.prepare("SELECT id, text FROM ideas WHERE project_id = ? AND is_deleted = 0 AND text LIKE ? LIMIT 10").bind(projectId, like).all(),
    db.prepare("SELECT id, text FROM tasks WHERE project_id = ? AND is_deleted = 0 AND text LIKE ? LIMIT 10").bind(projectId, like).all(),
    db
      .prepare(
        "SELECT id, COALESCE(url, '') || ' ' || COALESCE(description, '') AS text FROM links WHERE project_id = ? AND is_deleted = 0 AND (COALESCE(url, '') || ' ' || COALESCE(description, '')) LIKE ? LIMIT 10",
      )
      .bind(projectId, like)
      .all(),
    db.prepare("SELECT id, text FROM notes WHERE project_id = ? AND is_deleted = 0 AND text LIKE ? LIMIT 10").bind(projectId, like).all(),
    db.prepare("SELECT id, text FROM decisions WHERE project_id = ? AND is_deleted = 0 AND text LIKE ? LIMIT 10").bind(projectId, like).all(),
  ]);

  return [
    ...ideas.results.map((row) => ({ kind: "Идея", entity_type: "idea", ...row })),
    ...tasks.results.map((row) => ({ kind: "Задача", entity_type: "task", ...row })),
    ...links.results.map((row) => ({ kind: "Ссылка", entity_type: "link", ...row })),
    ...notes.results.map((row) => ({ kind: "Заметка", entity_type: "note", ...row })),
    ...decisions.results.map((row) => ({ kind: "Решение", entity_type: "decision", ...row })),
  ];
}

export async function listUsers(db) {
  const { results } = await db
    .prepare(
      "SELECT id, username, role, telegram_id, display_name, is_active, last_login_at, created_at, updated_at FROM users ORDER BY username",
    )
    .all();
  return results;
}

export async function getUser(db, userId) {
  return await db
    .prepare("SELECT id, username, role, telegram_id, display_name, is_active, last_login_at, created_at, updated_at FROM users WHERE id = ?")
    .bind(userId)
    .first();
}

export async function listAudit(db, limit = 100) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.user_id, COALESCE(u.display_name, u.username, '—') AS username, a.action, a.entity_type, a.entity_id, a.details_json, a.created_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results;
}
