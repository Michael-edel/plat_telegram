import {
  TASK_STATUSES,
  commandPayload,
  extractHashtags,
  isValidUrl,
  parseAllowedUsers,
  truncateText,
} from "./utils.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

async function sendMessage(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: truncateText(text),
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    console.error("Telegram sendMessage failed", response.status, await response.text());
  }
}

function isAllowed(env, userId) {
  const allowedUsers = parseAllowedUsers(env.ALLOWED_USERS || "");
  return allowedUsers.size === 0 || allowedUsers.has(userId);
}

async function getOrCreateProject(db, name) {
  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error("Название проекта не может быть пустым");
  }

  const existing = await db.prepare("SELECT * FROM projects WHERE name = ?").bind(cleanName).first();
  if (existing) {
    return existing;
  }

  const result = await db
    .prepare("INSERT INTO projects (name, created_at) VALUES (?, datetime('now')) RETURNING *")
    .bind(cleanName)
    .first();
  return result;
}

async function setActiveProject(db, chatId, name) {
  const project = await getOrCreateProject(db, name);
  await db
    .prepare(
      "INSERT INTO chat_projects (chat_id, project_id) VALUES (?, ?) " +
        "ON CONFLICT(chat_id) DO UPDATE SET project_id = excluded.project_id",
    )
    .bind(chatId, project.id)
    .run();
  return project;
}

async function getActiveProject(db, chatId) {
  return await db
    .prepare(
      "SELECT p.* FROM projects p " +
        "JOIN chat_projects cp ON cp.project_id = p.id " +
        "WHERE cp.chat_id = ?",
    )
    .bind(chatId)
    .first();
}

async function requireActiveProject(env, message) {
  const project = await getActiveProject(env.DB, message.chat.id);
  if (!project) {
    await sendMessage(env, message.chat.id, "Активный проект не выбран. Используйте /project_set название");
    return null;
  }
  return project;
}

async function saveTags(db, entityType, entityId, text) {
  const tags = extractHashtags(text);
  for (const tag of tags) {
    const row = await db
      .prepare("INSERT OR IGNORE INTO tags (name) VALUES (?) RETURNING id")
      .bind(tag)
      .first();
    const tagRow = row || (await db.prepare("SELECT id FROM tags WHERE name = ?").bind(tag).first());
    await db
      .prepare(
        "INSERT OR IGNORE INTO entity_tags (entity_type, entity_id, tag_id) VALUES (?, ?, ?)",
      )
      .bind(entityType, entityId, tagRow.id)
      .run();
  }
}

async function createTextEntity(env, table, entityType, projectId, text) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст не может быть пустым");
  }

  const row = await env.DB
    .prepare(`INSERT INTO ${table} (project_id, text, created_at) VALUES (?, ?, datetime('now')) RETURNING *`)
    .bind(projectId, cleanText)
    .first();
  await saveTags(env.DB, entityType, row.id, cleanText);
  return row;
}

async function handleStart(env, message) {
  await sendMessage(
    env,
    message.chat.id,
    [
      "Бот для совместной работы готов.",
      "",
      "/project_set название - выбрать проект",
      "/projects - список проектов",
      "/idea текст - сохранить идею",
      "/task текст - создать задачу",
      "/tasks - список задач",
      "/task_done id - завершить задачу",
      "/note текст - сохранить заметку",
      "/decision текст - зафиксировать решение",
      "/link url описание - сохранить ссылку",
      "/find запрос - поиск",
    ].join("\n"),
  );
}

async function handleProjectSet(env, message) {
  const name = commandPayload(message);
  if (!name) {
    await sendMessage(env, message.chat.id, "Укажите название проекта: /project_set название");
    return;
  }

  const project = await setActiveProject(env.DB, message.chat.id, name);
  await sendMessage(env, message.chat.id, `Активный проект: ${project.name}`);
}

async function handleProjects(env, message) {
  const { results } = await env.DB.prepare("SELECT name FROM projects ORDER BY name").all();
  if (!results.length) {
    await sendMessage(env, message.chat.id, "Проектов пока нет.");
    return;
  }
  await sendMessage(env, message.chat.id, `Проекты:\n${results.map((item) => `- ${item.name}`).join("\n")}`);
}

async function handleIdea(env, message) {
  const text = commandPayload(message);
  if (!text) {
    await sendMessage(env, message.chat.id, "Добавьте текст идеи: /idea текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const idea = await createTextEntity(env, "ideas", "idea", project.id, text);
  await sendMessage(env, message.chat.id, `Идея сохранена: #${idea.id}`);
}

async function handleTask(env, message) {
  const text = commandPayload(message);
  if (!text) {
    await sendMessage(env, message.chat.id, "Добавьте текст задачи: /task текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const task = await env.DB
    .prepare(
      "INSERT INTO tasks (project_id, text, status, created_at) VALUES (?, ?, 'todo', datetime('now')) RETURNING *",
    )
    .bind(project.id, text.trim())
    .first();
  await saveTags(env.DB, "task", task.id, text);
  await sendMessage(env, message.chat.id, `Задача создана: #${task.id}`);
}

async function handleTasks(env, message) {
  const project = await requireActiveProject(env, message);
  if (!project) return;

  const { results } = await env.DB
    .prepare("SELECT id, text, status FROM tasks WHERE project_id = ? ORDER BY status, created_at DESC")
    .bind(project.id)
    .all();

  const lines = [`Задачи проекта ${project.name}:`];
  for (const status of TASK_STATUSES) {
    lines.push("", `${status}:`);
    const tasks = results.filter((task) => task.status === status);
    lines.push(...(tasks.length ? tasks.map((task) => `#${task.id} ${task.text}`) : ["-"]));
  }
  await sendMessage(env, message.chat.id, lines.join("\n"));
}

async function handleTaskDone(env, message) {
  const payload = commandPayload(message);
  const taskId = Number.parseInt(payload, 10);
  if (!Number.isInteger(taskId)) {
    await sendMessage(env, message.chat.id, "Укажите id задачи: /task_done 1");
    return;
  }

  const project = await requireActiveProject(env, message);
  if (!project) return;

  const result = await env.DB
    .prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND project_id = ?")
    .bind(taskId, project.id)
    .run();

  if (!result.meta.changes) {
    await sendMessage(env, message.chat.id, "Задача не найдена в текущем проекте.");
    return;
  }
  await sendMessage(env, message.chat.id, `Задача #${taskId} завершена.`);
}

async function handleNote(env, message) {
  const text = commandPayload(message);
  if (!text) {
    await sendMessage(env, message.chat.id, "Добавьте текст заметки: /note текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const note = await createTextEntity(env, "notes", "note", project.id, text);
  await sendMessage(env, message.chat.id, `Заметка сохранена: #${note.id}`);
}

async function handleDecision(env, message) {
  const text = commandPayload(message);
  if (!text) {
    await sendMessage(env, message.chat.id, "Добавьте текст решения: /decision текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const decision = await createTextEntity(env, "decisions", "decision", project.id, text);
  await sendMessage(env, message.chat.id, `Решение сохранено: #${decision.id}`);
}

async function handleLink(env, message) {
  const payload = commandPayload(message);
  if (!payload) {
    await sendMessage(env, message.chat.id, "Добавьте ссылку: /link https://example.com описание");
    return;
  }

  const [url, ...descriptionParts] = payload.split(/\s+/);
  const description = descriptionParts.join(" ").trim();
  if (!isValidUrl(url)) {
    await sendMessage(env, message.chat.id, "Некорректная ссылка. Нужен URL с http или https");
    return;
  }

  const project = await requireActiveProject(env, message);
  if (!project) return;
  const link = await env.DB
    .prepare(
      "INSERT INTO links (project_id, url, description, created_at) VALUES (?, ?, ?, datetime('now')) RETURNING *",
    )
    .bind(project.id, url.trim(), description || null)
    .first();
  await saveTags(env.DB, "link", link.id, `${url} ${description}`);
  await sendMessage(env, message.chat.id, `Ссылка сохранена: #${link.id}`);
}

async function searchTable(db, table, kind, projectId, query) {
  const textColumn = table === "links" ? "COALESCE(url, '') || ' ' || COALESCE(description, '')" : "text";
  const { results } = await db
    .prepare(`SELECT id, ${textColumn} AS text FROM ${table} WHERE project_id = ? AND ${textColumn} LIKE ? LIMIT 10`)
    .bind(projectId, `%${query}%`)
    .all();
  return results.map((row) => `${kind} #${row.id}: ${row.text}`);
}

async function handleFind(env, message) {
  const query = commandPayload(message);
  if (!query) {
    await sendMessage(env, message.chat.id, "Укажите запрос: /find текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;

  const results = [
    ...(await searchTable(env.DB, "ideas", "Идея", project.id, query)),
    ...(await searchTable(env.DB, "tasks", "Задача", project.id, query)),
    ...(await searchTable(env.DB, "links", "Ссылка", project.id, query)),
    ...(await searchTable(env.DB, "notes", "Заметка", project.id, query)),
    ...(await searchTable(env.DB, "decisions", "Решение", project.id, query)),
  ];

  await sendMessage(env, message.chat.id, results.length ? `Найдено:\n${results.join("\n")}` : "Ничего не найдено.");
}

async function handleTelegramUpdate(env, update) {
  const message = update.message || update.edited_message;
  if (!message || !message.chat || !message.from) {
    return;
  }

  if (!isAllowed(env, message.from.id)) {
    if (message.chat.type === "private") {
      await sendMessage(env, message.chat.id, "Доступ закрыт.");
    }
    return;
  }

  const text = message.text || message.caption || "";
  const command = text.split(/\s+/, 1)[0].split("@", 1)[0];

  switch (command) {
    case "/start":
    case "/help":
      await handleStart(env, message);
      break;
    case "/project_set":
      await handleProjectSet(env, message);
      break;
    case "/projects":
      await handleProjects(env, message);
      break;
    case "/idea":
      await handleIdea(env, message);
      break;
    case "/task":
      await handleTask(env, message);
      break;
    case "/tasks":
      await handleTasks(env, message);
      break;
    case "/task_done":
      await handleTaskDone(env, message);
      break;
    case "/note":
      await handleNote(env, message);
      break;
    case "/decision":
      await handleDecision(env, message);
      break;
    case "/link":
      await handleLink(env, message);
      break;
    case "/find":
      await handleFind(env, message);
      break;
    default:
      break;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ status: "ok" });
    }

    if (url.pathname !== "/telegram/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (env.WEBHOOK_SECRET) {
      const actualSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (actualSecret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    const update = await request.json();
    await handleTelegramUpdate(env, update);
    return json({ ok: true });
  },
};
