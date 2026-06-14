import {
  TASK_STATUSES,
  commandPayload,
  isValidUrl,
  parseAllowedUsers,
  truncateText,
} from "./utils.js";
import { handleWebRequest } from "./web.js";
import { cleanupAuditLog, notifyTaskStatusChanged, runTaskDeadlineNotifications } from "./notifications.js";
import {
  createLink,
  createTask,
  createTextEntity as createRepositoryTextEntity,
  findUserByTelegramId,
  getOrCreateProject,
  updateTaskStatus,
} from "./repository.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

async function sendMessage(env, chatId, text, options = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: truncateText(text),
      disable_web_page_preview: true,
      ...options,
    }),
  });

  if (!response.ok) {
    console.error("Telegram sendMessage failed", response.status, await response.text());
  }
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  if (!callbackQueryId) return;
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: truncateText(text, 180),
    }),
  });

  if (!response.ok) {
    console.error("Telegram answerCallbackQuery failed", response.status, await response.text());
  }
}

async function editMessageText(env, chatId, messageId, text, options = {}) {
  if (!chatId || !messageId) return;
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: truncateText(text),
      disable_web_page_preview: true,
      ...options,
    }),
  });

  if (!response.ok) {
    console.error("Telegram editMessageText failed", response.status, await response.text());
  }
}

function taskKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "В работе", callback_data: `task:doing:${taskId}` },
        { text: "В ревью", callback_data: `task:review:${taskId}` },
        { text: "Готово", callback_data: `task:done:${taskId}` },
      ],
    ],
  };
}

function taskSummary(task, projectName, authorName = "—") {
  return `Задача #${task.id} создана в проекте ${projectName}. Статус: ${task.status || "todo"}. Автор: ${authorName}`;
}

async function scheduleBackground(ctx, promise) {
  if (ctx?.waitUntil) {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

function isAllowed(env, userId) {
  const allowedUsers = parseAllowedUsers(env.ALLOWED_USERS || "");
  return allowedUsers.size === 0 || allowedUsers.has(userId);
}

async function setActiveProject(db, chatId, name) {
  const project = await getOrCreateProject(db, name, null, "telegram");
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

async function createTextEntity(env, table, entityType, projectId, text, authorId = null) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст не может быть пустым");
  }

  return await createRepositoryTextEntity(env.DB, {
    table,
    entityType,
    projectId,
    text: cleanText,
    authorId,
    source: "telegram",
  });
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
      "/task_doing id - перевести задачу в doing",
      "/task_review id - перевести задачу в review",
      "/task_done id - завершить задачу",
      "/ideas - список идей",
      "/notes - список заметок",
      "/decisions - список решений",
      "/links - список ссылок",
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

async function handleIdea(env, message, user) {
  const text = commandPayload(message);
  if (!text) {
    await sendMessage(env, message.chat.id, "Добавьте текст идеи: /idea текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const idea = await createTextEntity(env, "ideas", "idea", project.id, text, user?.id || null);
  await sendMessage(env, message.chat.id, `Идея #${idea.id} сохранена в проекте ${project.name}. Автор: ${user?.username || message.from.username || message.from.first_name || "—"}`);
}

async function handleTask(env, message, user) {
  const text = commandPayload(message);
  if (!text) {
    await sendMessage(env, message.chat.id, "Добавьте текст задачи: /task текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const task = await createTask(env.DB, {
    projectId: project.id,
    text,
    authorId: user?.id || null,
    source: "telegram",
  });
  await sendMessage(env, message.chat.id, taskSummary(task, project.name, user?.username || message.from.username || message.from.first_name || "—"), {
    reply_markup: taskKeyboard(task.id),
  });
}

async function handleTasks(env, message) {
  const project = await requireActiveProject(env, message);
  if (!project) return;

  const { results } = await env.DB
    .prepare("SELECT id, text, status FROM tasks WHERE project_id = ? AND is_deleted = 0 ORDER BY status, created_at DESC")
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

async function handleTaskStatusCommand(env, message, user, status, commandName, ctx = null) {
  const payload = commandPayload(message);
  const taskId = Number.parseInt(payload, 10);
  if (!Number.isInteger(taskId)) {
    await sendMessage(env, message.chat.id, `Укажите id задачи: /${commandName} 1`);
    return;
  }

  const project = await requireActiveProject(env, message);
  if (!project) return;

  try {
    const result = await updateTaskStatus(env.DB, {
      taskId,
      projectId: project.id,
      status,
      userId: user?.id || null,
      source: "telegram",
    });
    await scheduleBackground(ctx, notifyTaskStatusChanged(env, result.taskId, result.oldStatus, result.newStatus));
  } catch {
    await sendMessage(env, message.chat.id, "Задача не найдена в текущем проекте.");
    return;
  }
  await sendMessage(env, message.chat.id, `Задача #${taskId} в проекте ${project.name}: статус ${status}.`);
}

async function handleTaskDone(env, message, user, ctx = null) {
  await handleTaskStatusCommand(env, message, user, "done", "task_done", ctx);
}

async function handleTaskCallback(env, callbackQuery, ctx = null) {
  const userId = callbackQuery.from?.id;
  if (!isAllowed(env, userId)) {
    await answerCallbackQuery(env, callbackQuery.id, "Доступ закрыт.");
    return;
  }

  const match = String(callbackQuery.data || "").match(/^task:(doing|review|done):(\d+)$/);
  if (!match) {
    await answerCallbackQuery(env, callbackQuery.id, "Неизвестное действие.");
    return;
  }

  const status = match[1];
  const taskId = Number.parseInt(match[2], 10);
  const task = await env.DB
    .prepare(
      `SELECT t.id, t.text, t.status, t.project_id, p.name AS project_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? AND t.is_deleted = 0`,
    )
    .bind(taskId)
    .first();

  if (!task) {
    await answerCallbackQuery(env, callbackQuery.id, "Задача не найдена.");
    return;
  }

  const user = await findUserByTelegramId(env.DB, userId);
  let result;
  try {
    result = await updateTaskStatus(env.DB, {
      taskId,
      projectId: task.project_id,
      status,
      userId: user?.id || null,
      source: "telegram_button",
    });
  } catch {
    await answerCallbackQuery(env, callbackQuery.id, "Не удалось изменить статус задачи.");
    return;
  }
  await scheduleBackground(ctx, notifyTaskStatusChanged(env, result.taskId, result.oldStatus, result.newStatus));
  await answerCallbackQuery(env, callbackQuery.id, `Статус: ${status}`);

  const message = callbackQuery.message;
  if (message?.chat?.id && message.message_id) {
    await editMessageText(env, message.chat.id, message.message_id, `Задача #${task.id} в проекте ${task.project_name}: ${task.text}\nСтатус: ${status}.`, {
      reply_markup: taskKeyboard(task.id),
    });
  }
}

async function handleNote(env, message, user) {
  const text = commandPayload(message);
  if (!text) {
    await sendMessage(env, message.chat.id, "Добавьте текст заметки: /note текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const note = await createTextEntity(env, "notes", "note", project.id, text, user?.id || null);
  await sendMessage(env, message.chat.id, `Заметка #${note.id} сохранена в проекте ${project.name}. Автор: ${user?.username || message.from.username || message.from.first_name || "—"}`);
}

async function handleDecision(env, message, user) {
  const text = commandPayload(message);
  if (!text) {
    await sendMessage(env, message.chat.id, "Добавьте текст решения: /decision текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const decision = await createTextEntity(env, "decisions", "decision", project.id, text, user?.id || null);
  await sendMessage(env, message.chat.id, `Решение #${decision.id} сохранено в проекте ${project.name}. Автор: ${user?.username || message.from.username || message.from.first_name || "—"}`);
}

async function handleLink(env, message, user) {
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
  const link = await createLink(env.DB, {
    projectId: project.id,
    url,
    description,
    authorId: user?.id || null,
    source: "telegram",
  });
  await sendMessage(env, message.chat.id, `Ссылка #${link.id} сохранена в проекте ${project.name}. Автор: ${user?.username || message.from.username || message.from.first_name || "—"}`);
}

async function handleEntityList(env, message, table, label) {
  const project = await requireActiveProject(env, message);
  if (!project) return;

  const textColumn = table === "links" ? "COALESCE(url, '') || CASE WHEN description IS NULL OR description = '' THEN '' ELSE ' - ' || description END" : "text";
  const { results } = await env.DB
    .prepare(
      `SELECT id, ${textColumn} AS text
       FROM ${table}
       WHERE project_id = ? AND is_deleted = 0
       ORDER BY created_at DESC
       LIMIT 30`,
    )
    .bind(project.id)
    .all();

  if (!results.length) {
    await sendMessage(env, message.chat.id, `${label} в проекте ${project.name} пока нет.`);
    return;
  }
  await sendMessage(env, message.chat.id, `${label} проекта ${project.name}:\n${results.map((row) => `#${row.id} ${row.text}`).join("\n")}`);
}

async function searchTable(db, table, kind, projectId, query) {
  const textColumn = table === "links" ? "COALESCE(url, '') || ' ' || COALESCE(description, '')" : "text";
  const { results } = await db
    .prepare(`SELECT id, ${textColumn} AS text FROM ${table} WHERE project_id = ? AND is_deleted = 0 AND ${textColumn} LIKE ? LIMIT 10`)
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

async function handleTelegramUpdate(env, update, ctx = null) {
  if (update.callback_query) {
    await handleTaskCallback(env, update.callback_query, ctx);
    return;
  }

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

  const user = await findUserByTelegramId(env.DB, message.from.id);

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
      await handleIdea(env, message, user);
      break;
    case "/task":
      await handleTask(env, message, user);
      break;
    case "/tasks":
      await handleTasks(env, message);
      break;
    case "/task_doing":
      await handleTaskStatusCommand(env, message, user, "doing", "task_doing", ctx);
      break;
    case "/task_review":
      await handleTaskStatusCommand(env, message, user, "review", "task_review", ctx);
      break;
    case "/task_done":
      await handleTaskDone(env, message, user, ctx);
      break;
    case "/ideas":
      await handleEntityList(env, message, "ideas", "Идеи");
      break;
    case "/notes":
      await handleEntityList(env, message, "notes", "Заметки");
      break;
    case "/decisions":
      await handleEntityList(env, message, "decisions", "Решения");
      break;
    case "/links":
      await handleEntityList(env, message, "links", "Ссылки");
      break;
    case "/note":
      await handleNote(env, message, user);
      break;
    case "/decision":
      await handleDecision(env, message, user);
      break;
    case "/link":
      await handleLink(env, message, user);
      break;
    case "/find":
      await handleFind(env, message);
      break;
    default:
      break;
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTaskDeadlineNotifications(env));
    ctx.waitUntil(cleanupAuditLog(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ status: "ok" });
    }

    if (
      url.pathname === "/" ||
      url.pathname === "/login" ||
      url.pathname === "/logout" ||
      url.pathname.startsWith("/app") ||
      url.pathname.startsWith("/api")
    ) {
      return await handleWebRequest(request, env, ctx);
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
    await handleTelegramUpdate(env, update, ctx);
    return json({ ok: true });
  },
};
