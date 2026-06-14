import { TASK_STATUSES, extractHashtags, normalizeTag } from "./utils.js";

export const ENTITY_CONFIG = {
  ideas: { table: "ideas", entityType: "idea", label: "Идеи", single: "Идея" },
  notes: { table: "notes", entityType: "note", label: "Заметки", single: "Заметка" },
  decisions: { table: "decisions", entityType: "decision", label: "Решения", single: "Решение" },
};

export const WORK_ENTITY_TABLES = new Set(["tasks", "ideas", "notes", "decisions", "links"]);
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"];

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

export async function changeLog(db, { userId = null, entityType, entityId, fieldName, oldValue = null, newValue = null, eventType = null, details = null }) {
  if (String(oldValue ?? "") === String(newValue ?? "")) {
    return;
  }
  await db
    .prepare(
      "INSERT INTO change_log (user_id, entity_type, entity_id, field_name, old_value, new_value, event_type, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    )
    .bind(userId, entityType, entityId, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), eventType, detailsJson(details))
    .run();
}

function cleanTaskPriority(priority) {
  return TASK_PRIORITIES.includes(priority) ? priority : "normal";
}

function cleanDate(value) {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function cleanAssigneeId(value) {
  const id = Number.parseInt(value || "", 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function previewText(value, maxLength = 180) {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
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

export async function findUsersByUsernames(db, usernames) {
  const cleanUsernames = [...new Set((usernames || []).map((item) => String(item || "").toLowerCase()).filter(Boolean))];
  if (!cleanUsernames.length) {
    return [];
  }
  const placeholders = cleanUsernames.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, username, display_name, telegram_id, role, is_active
       FROM users
       WHERE lower(username) IN (${placeholders}) AND is_active = 1`,
    )
    .bind(...cleanUsernames)
    .all();
  return results;
}

export async function findUserByUsername(db, username) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  if (!cleanUsername) {
    return null;
  }
  return await db
    .prepare("SELECT id, username, role, telegram_id, display_name, is_active FROM users WHERE lower(username) = ? AND is_active = 1")
    .bind(cleanUsername)
    .first();
}

export async function addEntityTags(db, entityType, entityId, tags) {
  const cleanTags = [...new Set((tags || []).map((tag) => normalizeTag(String(tag || ""))).filter(Boolean))];
  if (!cleanTags.length) {
    return;
  }
  for (const cleanTag of cleanTags) {
    const row = await db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?) RETURNING id").bind(cleanTag).first();
    const tagRow = row || (await db.prepare("SELECT id FROM tags WHERE name = ?").bind(cleanTag).first());
    await db
      .prepare("INSERT OR IGNORE INTO entity_tags (entity_type, entity_id, tag_id) VALUES (?, ?, ?)")
      .bind(entityType, entityId, tagRow.id)
      .run();
  }
}

export async function saveTags(db, entityType, entityId, text) {
  await db.prepare("DELETE FROM entity_tags WHERE entity_type = ? AND entity_id = ?").bind(entityType, entityId).run();
  await addEntityTags(db, entityType, entityId, extractHashtags(text));
}

function searchContent(entityType, row) {
  if (entityType === "link") {
    return `${row.url || ""} ${row.description || ""}`.trim();
  }
  return String(row.text || "").trim();
}

export async function syncSearchIndex(db, { entityType, entityId, projectId, content }) {
  try {
    await db.prepare("DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?").bind(entityType, entityId).run();
    if (content && String(content).trim()) {
      await db
        .prepare("INSERT INTO search_index (entity_type, entity_id, project_id, content) VALUES (?, ?, ?, ?)")
        .bind(entityType, entityId, projectId, String(content).trim())
        .run();
    }
  } catch (error) {
    console.error("Search index sync failed", entityType, entityId, error);
  }
}

export async function removeSearchIndex(db, entityType, entityId) {
  try {
    await db.prepare("DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?").bind(entityType, entityId).run();
  } catch (error) {
    console.error("Search index delete failed", entityType, entityId, error);
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

export function timezoneModifier(env = {}) {
  const offset = Number.parseInt(env.APP_TIMEZONE_OFFSET_HOURS || "", 10);
  if (!Number.isInteger(offset) || offset === 0) {
    return "+0 hours";
  }
  return `${offset > 0 ? "+" : ""}${offset} hours`;
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

export async function getProjectByName(db, name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) {
    return null;
  }
  return await db.prepare("SELECT * FROM projects WHERE name = ?").bind(cleanName).first();
}

function writeCount(result) {
  return Number(result?.meta?.changes ?? result?.meta?.rows_written ?? 0);
}

export async function reserve1CEvent(db, eventId) {
  const result = await db
    .prepare("INSERT OR IGNORE INTO processed_1c_events (event_id, status, created_at) VALUES (?, 'processing', CURRENT_TIMESTAMP)")
    .bind(eventId)
    .run();
  return writeCount(result) > 0;
}

export async function getProcessed1CEvent(db, eventId) {
  return await db
    .prepare("SELECT event_id, entity_type, entity_id, status, error_message, processed_at FROM processed_1c_events WHERE event_id = ?")
    .bind(eventId)
    .first();
}

export async function mark1CEventProcessed(db, { eventId, entityType, entityId }) {
  await db
    .prepare(
      "UPDATE processed_1c_events SET status = 'processed', entity_type = ?, entity_id = ?, error_message = NULL, processed_at = CURRENT_TIMESTAMP WHERE event_id = ?",
    )
    .bind(entityType, entityId, eventId)
    .run();
}

export async function mark1CEventFailed(db, { eventId, errorMessage }) {
  await db
    .prepare("UPDATE processed_1c_events SET status = 'failed', error_message = ?, processed_at = CURRENT_TIMESTAMP WHERE event_id = ?")
    .bind(previewText(errorMessage, 500), eventId)
    .run();
}

export async function listProjects(db, dueSoonDays = 3, tzModifier = "+0 hours") {
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
        (SELECT COUNT(*) FROM links WHERE project_id = p.id AND is_deleted = 0) AS links_count,
        (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND is_deleted = 0 AND status != 'done' AND due_date IS NOT NULL AND date(due_date) < date('now', ?)) AS overdue_count,
        (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND is_deleted = 0 AND status != 'done' AND due_date IS NOT NULL AND date(due_date) >= date('now', ?) AND date(due_date) <= date('now', ?, '+' || ? || ' days')) AS due_soon_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id
      ORDER BY p.name`,
    )
    .bind(tzModifier, tzModifier, tzModifier, dueSoonDays)
    .all();
  return results;
}

export async function getProject(db, projectId) {
  return await db.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
}

function authorSelect(alias = "u") {
  return `COALESCE(${alias}.display_name, ${alias}.username, '—') AS author_name`;
}

export async function loadProjectData(db, projectId, filters = {}, tzModifier = "+0 hours") {
  const taskFilters = addProjectFilters(["t.project_id = ?", "t.is_deleted = 0"], filters, "t", "task");
  const ideaFilters = addProjectFilters(["i.project_id = ?", "i.is_deleted = 0"], filters, "i", "idea");
  const noteFilters = addProjectFilters(["n.project_id = ?", "n.is_deleted = 0"], filters, "n", "note");
  const decisionFilters = addProjectFilters(["d.project_id = ?", "d.is_deleted = 0"], filters, "d", "decision");
  const linkFilters = addProjectFilters(["l.project_id = ?", "l.is_deleted = 0"], filters, "l", "link");
  if (filters.status) {
    taskFilters.whereSql += " AND t.status = ?";
    taskFilters.bindings.push(filters.status);
  }
  if (filters.priority) {
    taskFilters.whereSql += " AND t.priority = ?";
    taskFilters.bindings.push(filters.priority);
  }
  if (filters.assigneeId === "none") {
    taskFilters.whereSql += " AND t.assignee_id IS NULL";
  } else if (filters.assigneeId) {
    taskFilters.whereSql += " AND t.assignee_id = ?";
    taskFilters.bindings.push(filters.assigneeId);
  }
  if (filters.deadline === "none") {
    taskFilters.whereSql += " AND t.due_date IS NULL";
  }
  if (filters.deadline === "today") {
    taskFilters.whereSql += " AND date(t.due_date) = date('now', ?)";
    taskFilters.bindings.push(tzModifier);
  }
  if (filters.deadline === "week") {
    taskFilters.whereSql += " AND t.due_date IS NOT NULL AND date(t.due_date) >= date('now', ?) AND date(t.due_date) <= date('now', ?, '+7 days')";
    taskFilters.bindings.push(tzModifier, tzModifier);
  }
  if (filters.deadline === "overdue") {
    taskFilters.whereSql += " AND t.due_date IS NOT NULL AND date(t.due_date) < date('now', ?) AND t.status != 'done'";
    taskFilters.bindings.push(tzModifier);
  }

  const [tasks, ideas, notes, decisions, links, taskComments, taskActivities] = await Promise.all([
    db
      .prepare(
        `SELECT t.id, t.text, t.status, t.priority, t.due_date, t.assignee_id, au.display_name AS assignee_display_name, au.username AS assignee_username,
                t.created_at, t.updated_at, t.author_id, ${authorSelect()}, ${tagsSelect("t", "task")}
         FROM tasks t
         LEFT JOIN users u ON u.id = t.author_id
         LEFT JOIN users au ON au.id = t.assignee_id
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
    db
      .prepare(
        `SELECT c.id, c.task_id, c.body, c.created_at, c.updated_at, c.author_user_id,
                COALESCE(u.display_name, u.username, '—') AS author_name
         FROM task_comments c
         JOIN tasks t ON t.id = c.task_id
         LEFT JOIN users u ON u.id = c.author_user_id
         WHERE t.project_id = ? AND c.is_deleted = 0
         ORDER BY c.created_at ASC`,
      )
      .bind(projectId)
      .all(),
    db
      .prepare(
        `SELECT cl.id, cl.entity_id AS task_id, cl.field_name, cl.old_value, cl.new_value, cl.event_type, cl.details_json, cl.created_at,
                COALESCE(u.display_name, u.username, '—') AS user_name
         FROM change_log cl
         JOIN tasks t ON t.id = cl.entity_id
         LEFT JOIN users u ON u.id = cl.user_id
         WHERE cl.entity_type = 'task' AND t.project_id = ?
         ORDER BY cl.created_at DESC, cl.id DESC
         LIMIT 200`,
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
    taskComments: taskComments.results,
    taskActivities: taskActivities.results,
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

export async function listAssignableUsers(db) {
  const { results } = await db
    .prepare("SELECT id, username, display_name, role FROM users WHERE is_active = 1 AND role IN ('admin', 'manager', 'editor') ORDER BY username")
    .all();
  return results;
}

export async function createTask(db, { projectId, text, authorId = null, source = "web", priority = "normal", dueDate = null, assigneeId = null }) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст задачи не может быть пустым");
  }
  const task = await db
    .prepare(
      "INSERT INTO tasks (project_id, text, status, author_id, priority, due_date, assignee_id, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?, ?, ?, datetime('now'), datetime('now')) RETURNING *",
    )
    .bind(projectId, cleanText, authorId, cleanTaskPriority(priority), cleanDate(dueDate), cleanAssigneeId(assigneeId))
    .first();
  await saveTags(db, "task", task.id, cleanText);
  await auditLog(db, {
    userId: authorId,
    action: "task.created",
    entityType: "task",
    entityId: task.id,
    details: { project_id: projectId, source },
  });
  await changeLog(db, { userId: authorId, entityType: "task", entityId: task.id, fieldName: "created", oldValue: null, newValue: cleanText });
  await syncSearchIndex(db, { entityType: "task", entityId: task.id, projectId, content: cleanText });
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

  await db.batch([
    db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ? AND is_deleted = 0").bind(status, taskId, projectId),
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
      .bind(userId, "task.status_changed", "task", taskId, detailsJson({ project_id: projectId, old_status: existing.status, new_status: status, source })),
    db
      .prepare(
        "INSERT INTO change_log (user_id, entity_type, entity_id, field_name, old_value, new_value, event_type, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
      )
      .bind(userId, "task", taskId, "status", existing.status, status, "status_changed", detailsJson({ source })),
  ]);
  return { taskId, projectId, oldStatus: existing.status, newStatus: status };
}

export async function updateTaskText(db, { taskId, projectId, text, userId }) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст задачи не может быть пустым");
  }
  const existing = await db
    .prepare("SELECT id, text FROM tasks WHERE id = ? AND project_id = ? AND is_deleted = 0")
    .bind(taskId, projectId)
    .first();
  if (!existing) {
    throw new Error("Задача не найдена");
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
  await changeLog(db, {
    userId,
    entityType: "task",
    entityId: taskId,
    fieldName: "text",
    oldValue: existing.text,
    newValue: cleanText,
  });
  await syncSearchIndex(db, { entityType: "task", entityId: taskId, projectId, content: cleanText });
}

export async function updateTaskMeta(db, { taskId, projectId, priority, dueDate, assigneeId, userId }) {
  const existing = await db
    .prepare("SELECT id, priority, due_date, assignee_id FROM tasks WHERE id = ? AND project_id = ? AND is_deleted = 0")
    .bind(taskId, projectId)
    .first();
  if (!existing) {
    throw new Error("Задача не найдена");
  }

  const nextPriority = cleanTaskPriority(priority);
  const nextDueDate = cleanDate(dueDate);
  const nextAssigneeId = cleanAssigneeId(assigneeId);
  const dueDateChanged = String(existing.due_date || "") !== String(nextDueDate || "");
  await db
    .prepare(
      `UPDATE tasks
       SET priority = ?,
           due_date = ?,
           assignee_id = ?,
           due_soon_notified_at = CASE WHEN ? THEN NULL ELSE due_soon_notified_at END,
           overdue_notified_at = CASE WHEN ? THEN NULL ELSE overdue_notified_at END,
           updated_at = datetime('now')
       WHERE id = ? AND project_id = ? AND is_deleted = 0`,
    )
    .bind(nextPriority, nextDueDate, nextAssigneeId, dueDateChanged ? 1 : 0, dueDateChanged ? 1 : 0, taskId, projectId)
    .run();

  await Promise.all([
    changeLog(db, { userId, entityType: "task", entityId: taskId, fieldName: "priority", oldValue: existing.priority, newValue: nextPriority }),
    changeLog(db, { userId, entityType: "task", entityId: taskId, fieldName: "due_date", oldValue: existing.due_date, newValue: nextDueDate }),
    changeLog(db, { userId, entityType: "task", entityId: taskId, fieldName: "assignee_id", oldValue: existing.assignee_id, newValue: nextAssigneeId }),
  ]);
  await auditLog(db, {
    userId,
    action: "task.meta_changed",
    entityType: "task",
    entityId: taskId,
    details: { project_id: projectId, priority: nextPriority, due_date: nextDueDate, assignee_id: nextAssigneeId, source: "web" },
  });
  return {
    taskId,
    projectId,
    oldAssigneeId: existing.assignee_id,
    newAssigneeId: nextAssigneeId,
    oldDueDate: existing.due_date,
    newDueDate: nextDueDate,
  };
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
  await changeLog(db, { userId, entityType: "task", entityId: taskId, fieldName: "deleted", oldValue: "0", newValue: "1" });
  await removeSearchIndex(db, "task", taskId);
}

export async function getTaskForComment(db, taskId) {
  return await db
    .prepare(
      `SELECT t.id, t.project_id, t.text, t.status, t.is_deleted, p.name AS project_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`,
    )
    .bind(taskId)
    .first();
}

export async function createTaskComment(db, { taskId, authorUserId = null, body, source = "web", crossProjectContext = false }) {
  const cleanBody = String(body || "").trim();
  if (!cleanBody) {
    throw new Error("Комментарий не может быть пустым");
  }
  const task = await getTaskForComment(db, taskId);
  if (!task || task.is_deleted) {
    throw new Error("Задача не найдена");
  }

  const comment = await db
    .prepare(
      `INSERT INTO task_comments (task_id, author_user_id, body, created_at)
       VALUES (?, ?, ?, datetime('now'))
       RETURNING id, task_id, author_user_id, body, created_at, updated_at`,
    )
    .bind(taskId, authorUserId, cleanBody)
    .first();
  await changeLog(db, {
    userId: authorUserId,
    entityType: "task",
    entityId: taskId,
    fieldName: "comment",
    oldValue: null,
    newValue: previewText(cleanBody),
    eventType: "comment_added",
    details: { comment_id: comment.id, source },
  });
  await auditLog(db, {
    userId: authorUserId,
    action: crossProjectContext ? "comment.cross_project_context" : "comment.created",
    entityType: "task",
    entityId: taskId,
    details: { comment_id: comment.id, project_id: task.project_id, source },
  });
  return { ...comment, project_id: task.project_id, project_name: task.project_name, task_text: task.text };
}

export async function getTaskComment(db, commentId) {
  return await db
    .prepare(
      `SELECT c.id, c.task_id, c.author_user_id, c.body, c.is_deleted, t.project_id
       FROM task_comments c
       JOIN tasks t ON t.id = c.task_id
       WHERE c.id = ?`,
    )
    .bind(commentId)
    .first();
}

export async function updateTaskComment(db, { commentId, body, userId }) {
  const cleanBody = String(body || "").trim();
  if (!cleanBody) {
    throw new Error("Комментарий не может быть пустым");
  }
  const existing = await getTaskComment(db, commentId);
  if (!existing || existing.is_deleted) {
    throw new Error("Комментарий не найден");
  }
  await db
    .prepare("UPDATE task_comments SET body = ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0")
    .bind(cleanBody, commentId)
    .run();
  await changeLog(db, {
    userId,
    entityType: "task",
    entityId: existing.task_id,
    fieldName: "comment",
    oldValue: previewText(existing.body),
    newValue: previewText(cleanBody),
    eventType: "comment_edited",
    details: { comment_id: commentId },
  });
  await auditLog(db, { userId, action: "comment.edited", entityType: "task", entityId: existing.task_id, details: { comment_id: commentId, project_id: existing.project_id } });
  return { taskId: existing.task_id, projectId: existing.project_id };
}

export async function softDeleteTaskComment(db, { commentId, userId }) {
  const existing = await getTaskComment(db, commentId);
  if (!existing || existing.is_deleted) {
    throw new Error("Комментарий не найден");
  }
  await db.prepare("UPDATE task_comments SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(commentId).run();
  await changeLog(db, {
    userId,
    entityType: "task",
    entityId: existing.task_id,
    fieldName: "comment",
    oldValue: previewText(existing.body),
    newValue: "deleted",
    eventType: "comment_deleted",
    details: { comment_id: commentId },
  });
  await auditLog(db, { userId, action: "comment.deleted", entityType: "task", entityId: existing.task_id, details: { comment_id: commentId, project_id: existing.project_id } });
  return { taskId: existing.task_id, projectId: existing.project_id };
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
  await changeLog(db, { userId: authorId, entityType, entityId: row.id, fieldName: "created", oldValue: null, newValue: cleanText });
  await syncSearchIndex(db, { entityType, entityId: row.id, projectId, content: cleanText });
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

  const existing = await db.prepare(`SELECT id, text FROM ${table} WHERE id = ? AND project_id = ? AND is_deleted = 0`).bind(entityId, projectId).first();
  if (!existing) {
    throw new Error("Запись не найдена");
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
  await changeLog(db, {
    userId,
    entityType,
    entityId,
    fieldName: "text",
    oldValue: existing.text,
    newValue: cleanText,
  });
  await syncSearchIndex(db, { entityType, entityId, projectId, content: cleanText });
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
  await changeLog(db, { userId, entityType, entityId, fieldName: "deleted", oldValue: "0", newValue: "1" });
  await removeSearchIndex(db, entityType, entityId);
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
  await changeLog(db, { userId: authorId, entityType: "link", entityId: link.id, fieldName: "created", oldValue: null, newValue: cleanUrl });
  await syncSearchIndex(db, { entityType: "link", entityId: link.id, projectId, content: searchContent("link", link) });
  return link;
}

export async function updateLink(db, { linkId, projectId, url, description, userId }) {
  const cleanUrl = url.trim();
  const cleanDescription = description.trim();
  const existing = await db.prepare("SELECT id, url, description FROM links WHERE id = ? AND project_id = ? AND is_deleted = 0").bind(linkId, projectId).first();
  if (!existing) {
    throw new Error("Ссылка не найдена");
  }
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
  await Promise.all([
    changeLog(db, { userId, entityType: "link", entityId: linkId, fieldName: "url", oldValue: existing.url, newValue: cleanUrl }),
    changeLog(db, { userId, entityType: "link", entityId: linkId, fieldName: "description", oldValue: existing.description, newValue: cleanDescription || null }),
  ]);
  await syncSearchIndex(db, { entityType: "link", entityId: linkId, projectId, content: `${cleanUrl} ${cleanDescription}` });
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
  await changeLog(db, { userId, entityType: "link", entityId: linkId, fieldName: "deleted", oldValue: "0", newValue: "1" });
  await removeSearchIndex(db, "link", linkId);
}

function convertibleTable(entityType) {
  if (entityType === "idea") return "ideas";
  if (entityType === "link") return "links";
  return "";
}

function convertibleText(entityType, row) {
  if (entityType === "link") {
    return `${row.url || ""}${row.description ? ` ${row.description}` : ""}`.trim();
  }
  return String(row.text || "").trim();
}

export async function getConvertibleEntity(db, entityType, entityId) {
  const table = convertibleTable(entityType);
  if (!table) {
    throw new Error("Некорректный тип сущности");
  }
  const id = Number.parseInt(entityId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Некорректный id сущности");
  }
  const columns = entityType === "link" ? "id, project_id, url, description, is_deleted" : "id, project_id, text, is_deleted";
  return await db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`).bind(id).first();
}

export async function transferEntityTags(db, sourceType, sourceId, targetType, targetId) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO entity_tags (entity_type, entity_id, tag_id)
       SELECT ?, ?, tag_id
       FROM entity_tags
       WHERE entity_type = ? AND entity_id = ?`,
    )
    .bind(targetType, targetId, sourceType, sourceId)
    .run();
}

export async function convertEntityToTask(db, { entityType, entityId, userId }) {
  const table = convertibleTable(entityType);
  if (!table) {
    throw new Error("Некорректный тип сущности");
  }
  const source = await getConvertibleEntity(db, entityType, entityId);
  if (!source || source.is_deleted) {
    return { alreadyDeleted: true };
  }

  const text = convertibleText(entityType, source);
  const task = await createTask(db, {
    projectId: source.project_id,
    text,
    authorId: userId,
    source: "telegram_inline",
  });
  await transferEntityTags(db, entityType, source.id, "task", task.id);
  await db
    .prepare(`UPDATE ${table} SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`)
    .bind(source.id)
    .run();
  await removeSearchIndex(db, entityType, source.id);
  await auditLog(db, {
    userId,
    action: "convert_to_task",
    entityType,
    entityId: source.id,
    details: { project_id: source.project_id, task_id: task.id, source: "telegram_inline" },
  });
  await changeLog(db, {
    userId,
    entityType: "task",
    entityId: task.id,
    fieldName: "created_from_entity",
    oldValue: null,
    newValue: `${entityType}:${source.id}`,
    eventType: "task_created_from_entity",
    details: { source_entity_type: entityType, source_entity_id: source.id },
  });
  await changeLog(db, {
    userId,
    entityType,
    entityId: source.id,
    fieldName: "converted_to_task",
    oldValue: null,
    newValue: task.id,
    eventType: "entity_converted_to_task",
    details: { task_id: task.id },
  });
  return { task, source };
}

export async function archiveEntity(db, { entityType, entityId, userId }) {
  const table = convertibleTable(entityType);
  if (!table) {
    throw new Error("Некорректный тип сущности");
  }
  const source = await getConvertibleEntity(db, entityType, entityId);
  if (!source || source.is_deleted) {
    return { alreadyDeleted: true };
  }
  await db
    .prepare(`UPDATE ${table} SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`)
    .bind(source.id)
    .run();
  await removeSearchIndex(db, entityType, source.id);
  await auditLog(db, {
    userId,
    action: "archive_entity",
    entityType,
    entityId: source.id,
    details: { project_id: source.project_id, source: "telegram_inline" },
  });
  await changeLog(db, {
    userId,
    entityType,
    entityId: source.id,
    fieldName: "archived",
    oldValue: "0",
    newValue: "1",
    eventType: "entity_archived",
    details: { source: "telegram_inline" },
  });
  return { source };
}

function ftsQuery(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" ");
}

async function searchProjectFts(db, projectId, query, filters = {}) {
  if (filters.tag) return null;
  const match = ftsQuery(query);
  if (!match) return [];
  const { results } = await db
    .prepare(
      `SELECT entity_type, entity_id, project_id, snippet(search_index, 3, '', '', '…', 12) AS preview
       FROM search_index
       WHERE search_index MATCH ? AND project_id = ?
       LIMIT 30`,
    )
    .bind(match, projectId)
    .all();
  const output = [];
  for (const item of results) {
    if (filters.entityType && item.entity_type !== filters.entityType) continue;
    const row = await searchResultRow(db, item.entity_type, item.entity_id, projectId);
    if (row) {
      output.push({ ...row, text: item.preview || row.text });
    }
  }
  return output;
}

async function searchResultRow(db, entityType, entityId, projectId) {
  const labels = { task: "Задача", idea: "Идея", note: "Заметка", decision: "Решение", link: "Ссылка" };
  if (entityType === "task") {
    const row = await db.prepare("SELECT id, text FROM tasks WHERE id = ? AND project_id = ? AND is_deleted = 0").bind(entityId, projectId).first();
    return row ? { kind: labels.task, entity_type: "task", ...row } : null;
  }
  if (entityType === "link") {
    const row = await db
      .prepare("SELECT id, COALESCE(url, '') || ' ' || COALESCE(description, '') AS text FROM links WHERE id = ? AND project_id = ? AND is_deleted = 0")
      .bind(entityId, projectId)
      .first();
    return row ? { kind: labels.link, entity_type: "link", ...row } : null;
  }
  const table = ENTITY_TABLE_BY_TYPE[entityType];
  if (!table || !labels[entityType]) return null;
  const row = await db.prepare(`SELECT id, text FROM ${table} WHERE id = ? AND project_id = ? AND is_deleted = 0`).bind(entityId, projectId).first();
  return row ? { kind: labels[entityType], entity_type: entityType, ...row } : null;
}

export async function searchProject(db, projectId, query, filters = {}) {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return [];
  }

  try {
    const ftsResults = await searchProjectFts(db, projectId, cleanQuery, filters);
    if (ftsResults) {
      return ftsResults;
    }
  } catch (error) {
    console.error("FTS search failed, falling back to LIKE", error);
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

export async function listProjectChanges(db, projectId, filters = {}, limit = 100) {
  const conditions = ["COALESCE(t.project_id, i.project_id, n.project_id, d.project_id, l.project_id) = ?"];
  const bindings = [projectId];
  if (filters.entityType) {
    conditions.push("c.entity_type = ?");
    bindings.push(filters.entityType);
  }
  if (filters.userId) {
    conditions.push("c.user_id = ?");
    bindings.push(filters.userId);
  }
  const { results } = await db
    .prepare(
      `SELECT c.id, c.entity_type, c.entity_id, c.field_name, c.old_value, c.new_value, c.created_at,
              COALESCE(u.display_name, u.username, '—') AS username
       FROM change_log c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN tasks t ON c.entity_type = 'task' AND c.entity_id = t.id
       LEFT JOIN ideas i ON c.entity_type = 'idea' AND c.entity_id = i.id
       LEFT JOIN notes n ON c.entity_type = 'note' AND c.entity_id = n.id
       LEFT JOIN decisions d ON c.entity_type = 'decision' AND c.entity_id = d.id
       LEFT JOIN links l ON c.entity_type = 'link' AND c.entity_id = l.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.created_at DESC
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
  const titleColumn = entityType === "link" ? "COALESCE(url, '') || ' ' || COALESCE(description, '') AS content" : "text AS content";
  const existing = await db.prepare(`SELECT id, project_id, ${titleColumn} FROM ${table} WHERE id = ? AND is_deleted = 1`).bind(entityId).first();
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
  await changeLog(db, { userId, entityType, entityId, fieldName: "restored", oldValue: "1", newValue: "0" });
  await syncSearchIndex(db, { entityType, entityId, projectId: existing.project_id, content: existing.content });
  return existing;
}
