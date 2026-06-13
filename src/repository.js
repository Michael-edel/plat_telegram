import { TASK_STATUSES, extractHashtags } from "./utils.js";

export const ENTITY_CONFIG = {
  ideas: { table: "ideas", entityType: "idea", label: "Идеи", single: "Идея" },
  notes: { table: "notes", entityType: "note", label: "Заметки", single: "Заметка" },
  decisions: { table: "decisions", entityType: "decision", label: "Решения", single: "Решение" },
};

export const WORK_ENTITY_TABLES = new Set(["tasks", "ideas", "notes", "decisions", "links"]);

const ENTITY_TABLE_BY_TYPE = {
  task: "tasks",
  idea: "ideas",
  note: "notes",
  decision: "decisions",
  link: "links",
};

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
  await db.prepare("DELETE FROM entity_tags WHERE entity_type = ? AND entity_id = ?").bind(entityType, entityId).run();
  for (const tag of tags) {
    const row = await db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?) RETURNING id").bind(tag).first();
    const tagRow = row || (await db.prepare("SELECT id FROM tags WHERE name = ?").bind(tag).first());
    await db
      .prepare("INSERT OR IGNORE INTO entity_tags (entity_type, entity_id, tag_id) VALUES (?, ?, ?)")
      .bind(entityType, entityId, tagRow.id)
      .run();
  }
}

function tagsSelect(alias, entityType) {
  return `(SELECT GROUP_CONCAT(tg.name, ', ')
          FROM entity_tags et
          JOIN tags tg ON tg.id = et.tag_id
          WHERE et.entity_type = '${entityType}' AND et.entity_id = ${alias}.id) AS tags`;
}

function addProjectFilters(baseWhere, filters = {}, alias = "t", entityType = "task") {
  const conditions = [...baseWhere];
  const bindings = [];
  if (filters.authorId) {
    conditions.push(`${alias}.author_id = ?`);
    bindings.push(filters.authorId);
  }
  if (filters.tag) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM entity_tags et
        JOIN tags tg ON tg.id = et.tag_id
        WHERE et.entity_type = ? AND et.entity_id = ${alias}.id AND tg.name = ?
      )`,
    );
    bindings.push(entityType, filters.tag);
  }
  return { whereSql: conditions.join(" AND "), bindings };
}

function bindOptional(statement, bindings) {
  return bindings.length ? statement.bind(...bindings) : statement;
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

export async function loadProjectData(db, projectId, filters = {}) {
  const taskFilters = addProjectFilters(["t.project_id = ?", "t.is_deleted = 0"], filters, "t", "task");
  const ideaFilters = addProjectFilters(["i.project_id = ?", "i.is_deleted = 0"], filters, "i", "idea");
  const noteFilters = addProjectFilters(["n.project_id = ?", "n.is_deleted = 0"], filters, "n", "note");
  const decisionFilters = addProjectFilters(["d.project_id = ?", "d.is_deleted = 0"], filters, "d", "decision");
  const linkFilters = addProjectFilters(["l.project_id = ?", "l.is_deleted = 0"], filters, "l", "link");
  if (filters.status) {
    taskFilters.whereSql += " AND t.status = ?";
    taskFilters.bindings.push(filters.status);
  }

  const [tasks, ideas, notes, decisions, links] = await Promise.all([
    db
      .prepare(
        `SELECT t.id, t.text, t.status, t.created_at, t.updated_at, t.author_id, ${authorSelect()}, ${tagsSelect("t", "task")}
         FROM tasks t
         LEFT JOIN users u ON u.id = t.author_id
         WHERE ${taskFilters.whereSql}
         ORDER BY t.created_at DESC`,
      )
      .bind(projectId, ...taskFilters.bindings)
      .all(),
    db
      .prepare(
        `SELECT i.id, i.text, i.created_at, i.updated_at, i.author_id, ${authorSelect()}, ${tagsSelect("i", "idea")}
         FROM ideas i
         LEFT JOIN users u ON u.id = i.author_id
         WHERE ${ideaFilters.whereSql}
         ORDER BY i.created_at DESC LIMIT 100`,
      )
      .bind(projectId, ...ideaFilters.bindings)
      .all(),
    db
      .prepare(
        `SELECT n.id, n.text, n.created_at, n.updated_at, n.author_id, ${authorSelect()}, ${tagsSelect("n", "note")}
         FROM notes n
         LEFT JOIN users u ON u.id = n.author_id
         WHERE ${noteFilters.whereSql}
         ORDER BY n.created_at DESC LIMIT 100`,
      )
      .bind(projectId, ...noteFilters.bindings)
      .all(),
    db
      .prepare(
        `SELECT d.id, d.text, d.created_at, d.updated_at, d.author_id, ${authorSelect()}, ${tagsSelect("d", "decision")}
         FROM decisions d
         LEFT JOIN users u ON u.id = d.author_id
         WHERE ${decisionFilters.whereSql}
         ORDER BY d.created_at DESC LIMIT 100`,
      )
      .bind(projectId, ...decisionFilters.bindings)
      .all(),
    db
      .prepare(
        `SELECT l.id, l.url, l.description, l.created_at, l.updated_at, l.author_id, ${authorSelect()}, ${tagsSelect("l", "link")}
         FROM links l
         LEFT JOIN users u ON u.id = l.author_id
         WHERE ${linkFilters.whereSql}
         ORDER BY l.created_at DESC LIMIT 100`,
      )
      .bind(projectId, ...linkFilters.bindings)
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

export async function listProjectAuthors(db, projectId) {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.id, COALESCE(u.display_name, u.username) AS name
       FROM users u
       JOIN (
         SELECT author_id FROM tasks WHERE project_id = ? AND is_deleted = 0
         UNION SELECT author_id FROM ideas WHERE project_id = ? AND is_deleted = 0
         UNION SELECT author_id FROM notes WHERE project_id = ? AND is_deleted = 0
         UNION SELECT author_id FROM decisions WHERE project_id = ? AND is_deleted = 0
         UNION SELECT author_id FROM links WHERE project_id = ? AND is_deleted = 0
       ) a ON a.author_id = u.id
       ORDER BY name`,
    )
    .bind(projectId, projectId, projectId, projectId, projectId)
    .all();
  return results;
}

export async function listProjectTags(db, projectId) {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT tg.name
       FROM tags tg
       JOIN entity_tags et ON et.tag_id = tg.id
       LEFT JOIN tasks task ON et.entity_type = 'task' AND et.entity_id = task.id
       LEFT JOIN ideas idea ON et.entity_type = 'idea' AND et.entity_id = idea.id
       LEFT JOIN notes note ON et.entity_type = 'note' AND et.entity_id = note.id
       LEFT JOIN decisions decision ON et.entity_type = 'decision' AND et.entity_id = decision.id
       LEFT JOIN links link ON et.entity_type = 'link' AND et.entity_id = link.id
       WHERE COALESCE(task.project_id, idea.project_id, note.project_id, decision.project_id, link.project_id) = ?
         AND COALESCE(task.is_deleted, idea.is_deleted, note.is_deleted, decision.is_deleted, link.is_deleted, 0) = 0
       ORDER BY tg.name`,
    )
    .bind(projectId)
    .all();
  return results;
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

export async function updateTaskStatus(db, { taskId, projectId, status, userId, source = "web" }) {
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
    details: { project_id: projectId, old_status: existing.status, new_status: status, source },
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

export async function searchProject(db, projectId, query, filters = {}) {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return [];
  }

  const tagFilter = (alias, entityType) =>
    filters.tag
      ? ` AND EXISTS (
        SELECT 1 FROM entity_tags et
        JOIN tags tg ON tg.id = et.tag_id
        WHERE et.entity_type = '${entityType}' AND et.entity_id = ${alias}.id AND tg.name = ?
      )`
      : "";
  const like = `%${cleanQuery}%`;
  const [ideas, tasks, links, notes, decisions] = await Promise.all([
    db
      .prepare(
        `SELECT i.id, i.text FROM ideas i WHERE i.project_id = ? AND i.is_deleted = 0 AND i.text LIKE ?${tagFilter("i", "idea")} LIMIT 10`,
      )
      .bind(...(filters.tag ? [projectId, like, filters.tag] : [projectId, like]))
      .all(),
    db
      .prepare(
        `SELECT t.id, t.text FROM tasks t WHERE t.project_id = ? AND t.is_deleted = 0 AND t.text LIKE ?${tagFilter("t", "task")} LIMIT 10`,
      )
      .bind(...(filters.tag ? [projectId, like, filters.tag] : [projectId, like]))
      .all(),
    db
      .prepare(
        `SELECT l.id, COALESCE(l.url, '') || ' ' || COALESCE(l.description, '') AS text FROM links l WHERE l.project_id = ? AND l.is_deleted = 0 AND (COALESCE(l.url, '') || ' ' || COALESCE(l.description, '')) LIKE ?${tagFilter("l", "link")} LIMIT 10`,
      )
      .bind(...(filters.tag ? [projectId, like, filters.tag] : [projectId, like]))
      .all(),
    db
      .prepare(
        `SELECT n.id, n.text FROM notes n WHERE n.project_id = ? AND n.is_deleted = 0 AND n.text LIKE ?${tagFilter("n", "note")} LIMIT 10`,
      )
      .bind(...(filters.tag ? [projectId, like, filters.tag] : [projectId, like]))
      .all(),
    db
      .prepare(
        `SELECT d.id, d.text FROM decisions d WHERE d.project_id = ? AND d.is_deleted = 0 AND d.text LIKE ?${tagFilter("d", "decision")} LIMIT 10`,
      )
      .bind(...(filters.tag ? [projectId, like, filters.tag] : [projectId, like]))
      .all(),
  ]);

  return [
    ...ideas.results.map((row) => ({ kind: "Идея", entity_type: "idea", ...row })),
    ...tasks.results.map((row) => ({ kind: "Задача", entity_type: "task", ...row })),
    ...links.results.map((row) => ({ kind: "Ссылка", entity_type: "link", ...row })),
    ...notes.results.map((row) => ({ kind: "Заметка", entity_type: "note", ...row })),
    ...decisions.results.map((row) => ({ kind: "Решение", entity_type: "decision", ...row })),
  ];
}

export async function listUsers(db, filters = {}) {
  const conditions = [];
  const bindings = [];
  if (filters.role) {
    conditions.push("role = ?");
    bindings.push(filters.role);
  }
  if (filters.active === "1" || filters.active === "0") {
    conditions.push("is_active = ?");
    bindings.push(Number(filters.active));
  }
  const statement = db.prepare(
    `SELECT id, username, role, telegram_id, display_name, is_active, last_login_at, created_at, updated_at
     FROM users
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY username`,
  );
  const { results } = await bindOptional(statement, bindings).all();
  return results;
}

export async function getUser(db, userId) {
  return await db
    .prepare("SELECT id, username, role, telegram_id, display_name, is_active, last_login_at, created_at, updated_at FROM users WHERE id = ?")
    .bind(userId)
    .first();
}

export async function listAudit(db, filters = {}, limit = 100) {
  const conditions = [];
  const bindings = [];
  if (filters.userId) {
    conditions.push("a.user_id = ?");
    bindings.push(filters.userId);
  }
  if (filters.action) {
    conditions.push("a.action LIKE ?");
    bindings.push(`%${filters.action}%`);
  }
  if (filters.entityType) {
    conditions.push("a.entity_type = ?");
    bindings.push(filters.entityType);
  }
  const { results } = await db
    .prepare(
      `SELECT a.id, a.user_id, COALESCE(u.display_name, u.username, '—') AS username, a.action, a.entity_type, a.entity_id, a.details_json, a.created_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY a.created_at DESC
       LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all();
  return results;
}

export async function listDeletedEntities(db) {
  const { results } = await db
    .prepare(
      `SELECT 'task' AS entity_type, t.id, t.project_id, p.name AS project_name, t.text AS title, t.deleted_at, ${authorSelect()}
       FROM tasks t LEFT JOIN users u ON u.id = t.author_id JOIN projects p ON p.id = t.project_id WHERE t.is_deleted = 1
       UNION ALL
       SELECT 'idea', i.id, i.project_id, p.name, i.text, i.deleted_at, ${authorSelect()}
       FROM ideas i LEFT JOIN users u ON u.id = i.author_id JOIN projects p ON p.id = i.project_id WHERE i.is_deleted = 1
       UNION ALL
       SELECT 'note', n.id, n.project_id, p.name, n.text, n.deleted_at, ${authorSelect()}
       FROM notes n LEFT JOIN users u ON u.id = n.author_id JOIN projects p ON p.id = n.project_id WHERE n.is_deleted = 1
       UNION ALL
       SELECT 'decision', d.id, d.project_id, p.name, d.text, d.deleted_at, ${authorSelect()}
       FROM decisions d LEFT JOIN users u ON u.id = d.author_id JOIN projects p ON p.id = d.project_id WHERE d.is_deleted = 1
       UNION ALL
       SELECT 'link', l.id, l.project_id, p.name, COALESCE(l.url, '') || ' ' || COALESCE(l.description, ''), l.deleted_at, ${authorSelect()}
       FROM links l LEFT JOIN users u ON u.id = l.author_id JOIN projects p ON p.id = l.project_id WHERE l.is_deleted = 1
       ORDER BY deleted_at DESC
       LIMIT 200`,
    )
    .all();
  return results;
}

export async function restoreEntity(db, { entityType, entityId, userId }) {
  const table = ENTITY_TABLE_BY_TYPE[entityType];
  if (!table) {
    throw new Error("Некорректный тип записи");
  }
  const existing = await db.prepare(`SELECT id, project_id FROM ${table} WHERE id = ? AND is_deleted = 1`).bind(entityId).first();
  if (!existing) {
    throw new Error("Удалённая запись не найдена");
  }
  await db.prepare(`UPDATE ${table} SET is_deleted = 0, deleted_at = NULL, updated_at = datetime('now') WHERE id = ?`).bind(entityId).run();
  await auditLog(db, {
    userId,
    action: `${entityType}.restored`,
    entityType,
    entityId,
    details: { project_id: existing.project_id, source: "web" },
  });
  return existing;
}
