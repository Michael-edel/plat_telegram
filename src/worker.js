import {
  TASK_STATUSES,
  commandPayload,
  isValidUrl,
  parseAllowedUsers,
  isTaskStatus,
  taskWebButton,
  truncateTelegramText,
} from "./utils.js";
import { handleWebRequest } from "./web.js";
import { cleanupAuditLog, notifyMentionedUsers, notifyTaskStatusChanged, runTaskDeadlineNotifications } from "./notifications.js";
import {
  archiveEntity,
  convertEntityToTask,
  createTaskComment,
  createLink,
  createTask,
  createTextEntity as createRepositoryTextEntity,
  findUserByTelegramId,
  getTaskForComment,
  getOrCreateProject,
  updateTaskStatus,
} from "./repository.js";

const TELEGRAM_WRITE_ROLES = new Set(["admin", "manager", "editor"]);
const TELEGRAM_AUDIO_LIMIT_BYTES = 25 * 1024 * 1024;
const GEMINI_INLINE_AUDIO_LIMIT_BYTES = 18 * 1024 * 1024;
const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe";
const DEFAULT_GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-flash";
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

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
      text: truncateTelegramText(text),
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
      text: truncateTelegramText(text, 180),
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
      text: truncateTelegramText(text),
      disable_web_page_preview: true,
      ...options,
    }),
  });

  if (!response.ok) {
    console.error("Telegram editMessageText failed", response.status, await response.text());
  }
}

function taskKeyboard(env, taskId, projectId, currentStatus = "") {
  const statusButtons =
    currentStatus === "done"
      ? []
      : [
          ["doing", "В работе"],
          ["review", "В ревью"],
          ["done", "Готово"],
        ]
          .filter(([status]) => status !== currentStatus)
          .map(([status, label]) => ({ text: label, callback_data: `task_status:${status}:${taskId}` }));
  const keyboard = [];
  if (statusButtons.length) {
    keyboard.push(statusButtons);
  }
  const webButton = taskWebButton(env, projectId, taskId);
  if (webButton) {
    keyboard.push([webButton]);
  }
  return { inline_keyboard: keyboard };
}

function entityActionKeyboard(entityType, entityId) {
  return {
    inline_keyboard: [
      [
        { text: "Создать задачу", callback_data: `convert_to_task:${entityType}:${entityId}` },
        { text: "В архив", callback_data: `archive_entity:${entityType}:${entityId}` },
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

export function canTelegramWrite(user) {
  return Boolean(user?.is_active && TELEGRAM_WRITE_ROLES.has(user.role));
}

function parseTaskStatusCallback(data) {
  const match = String(data || "").match(/^(?:task_status|task):(doing|review|done):(\d+)$/);
  if (!match) return null;
  const taskId = Number.parseInt(match[2], 10);
  if (!Number.isInteger(taskId) || !isTaskStatus(match[1])) return null;
  return { status: match[1], taskId };
}

export function parseEntityActionCallback(data) {
  const match = String(data || "").match(/^(convert_to_task|archive_entity):(idea|link):(\d+)$/);
  if (!match) return null;
  const entityId = Number.parseInt(match[3], 10);
  if (!Number.isInteger(entityId) || entityId <= 0) return null;
  return { action: match[1], entityType: match[2], entityId };
}

function stripIntakePrefix(text, patterns) {
  let value = String(text || "").trim();
  for (const pattern of patterns) {
    value = value.replace(pattern, "").trim();
  }
  return value;
}

function normalizeNaturalTaskStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["doing", "работу", "в работе"].includes(normalized)) return "doing";
  if (["review", "ревью", "проверку", "на проверку"].includes(normalized)) return "review";
  if (["done", "готово", "закрыто", "завершено"].includes(normalized)) return "done";
  return "";
}

export function classifyTelegramIntake(text) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return null;
  const projectMatch = cleanText.match(/^(?:создай|создать|создайте|выбери|выбрать|переключи|переключить)\s+(?:новый\s+)?проект\s+(.+)$/i);
  if (projectMatch?.[1]?.trim()) {
    return { type: "project", text: projectMatch[1].trim() };
  }
  const listMatch = cleanText.match(/^(?:покажи|показать|список)\s+(проекты|проектов|задачи|задач|идеи|идей|заметки|заметок|решения|решений|ссылки|ссылок)$/i);
  if (listMatch) {
    const target = listMatch[1].toLowerCase();
    const listType = target.startsWith("проект") ? "projects" : target.startsWith("задач") ? "tasks" : target.startsWith("иде") ? "ideas" : target.startsWith("замет") ? "notes" : target.startsWith("решен") ? "decisions" : "links";
    return { type: "list", listType };
  }
  const statusMatch = cleanText.match(/^(?:переведи|поставь)\s+задач[ауи]?\s+#?(\d+)\s+(?:в|на)\s+(работу|в работе|doing|ревью|review|проверку|на проверку|готово|done)$/i);
  if (statusMatch) {
    const status = normalizeNaturalTaskStatus(statusMatch[2]);
    if (status) return { type: "task_status", taskId: statusMatch[1], status };
  }
  const doneMatch = cleanText.match(/^(?:закрой|закрыть|заверши|завершить)\s+задач[ауи]?\s+#?(\d+)$/i);
  if (doneMatch) {
    return { type: "task_status", taskId: doneMatch[1], status: "done" };
  }
  const commentMatch = cleanText.match(/^(?:добавь|добавить|запиши|написать)?\s*комментарий\s+(?:к\s+)?задач[еуы]?\s+#?(\d+)\s+(.+)$/i);
  if (commentMatch?.[2]?.trim()) {
    return { type: "comment", taskId: commentMatch[1], text: commentMatch[2].trim() };
  }
  const findMatch = cleanText.match(/^(?:найди|найти|поиск)\s+(.+)$/i);
  if (findMatch?.[1]?.trim()) {
    return { type: "find", text: findMatch[1].trim() };
  }
  const naturalEntityMatch = cleanText.match(/^(?:создай|создать|создайте|добавь|добавить|сохрани|сохранить|запиши|записать|зафиксируй|зафиксировать)\s+(идею|идея|задачу|задача|заметку|заметка|решение|ссылку|ссылка)\s+(.+)$/i);
  if (naturalEntityMatch?.[2]?.trim()) {
    const entity = naturalEntityMatch[1].toLowerCase();
    const type = entity.startsWith("иде") ? "idea" : entity.startsWith("задач") ? "task" : entity.startsWith("замет") ? "note" : entity.startsWith("решен") ? "decision" : "link";
    if (type === "link") {
      const urlMatch = naturalEntityMatch[2].match(URL_PATTERN);
      if (urlMatch) {
        return { type: "link", url: urlMatch[0], description: naturalEntityMatch[2].replace(urlMatch[0], "").trim() };
      }
    }
    return { type, text: naturalEntityMatch[2].trim() };
  }
  const urlMatch = cleanText.match(URL_PATTERN);
  if (urlMatch) {
    return {
      type: "link",
      url: urlMatch[0],
      description: cleanText.replace(urlMatch[0], "").replace(/^(ссылка|link)\s*[:\-]?\s*/i, "").trim(),
    };
  }
  if (/^(идея|idea)\s*[:\-]/i.test(cleanText) || /^идея\s+/i.test(cleanText)) {
    return { type: "idea", text: stripIntakePrefix(cleanText, [/^(идея|idea)\s*[:\-]?\s*/i]) };
  }
  if (/^(задача|task)\s*[:\-]/i.test(cleanText) || /^задача\s+/i.test(cleanText)) {
    return { type: "task", text: stripIntakePrefix(cleanText, [/^(задача|task)\s*[:\-]?\s*/i]) };
  }
  if (/^(решение|decision)\s*[:\-]/i.test(cleanText) || /^решение\s+/i.test(cleanText)) {
    return { type: "decision", text: stripIntakePrefix(cleanText, [/^(решение|decision)\s*[:\-]?\s*/i]) };
  }
  if (/^(заметка|note)\s*[:\-]/i.test(cleanText) || /^заметка\s+/i.test(cleanText)) {
    return { type: "note", text: stripIntakePrefix(cleanText, [/^(заметка|note)\s*[:\-]?\s*/i]) };
  }
  return { type: "note", text: cleanText };
}

async function getTelegramTask(db, taskId) {
  return await db
    .prepare(
      `SELECT t.id, t.text, t.status, t.project_id, t.is_deleted, p.name AS project_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`,
    )
    .bind(taskId)
    .first();
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

async function setPendingChatAction(db, chatId, action) {
  await db
    .prepare(
      "INSERT INTO telegram_chat_state (chat_id, pending_action, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now')) " +
        "ON CONFLICT(chat_id) DO UPDATE SET pending_action = excluded.pending_action, updated_at = datetime('now')",
    )
    .bind(chatId, action)
    .run();
}

async function getPendingChatAction(db, chatId) {
  const row = await db.prepare("SELECT pending_action FROM telegram_chat_state WHERE chat_id = ?").bind(chatId).first();
  return row?.pending_action || "";
}

async function clearPendingChatAction(db, chatId) {
  await db.prepare("DELETE FROM telegram_chat_state WHERE chat_id = ?").bind(chatId).run();
}

async function requireActiveProject(env, message) {
  const project = await getActiveProject(env.DB, message.chat.id);
  if (!project) {
    await sendMessage(env, message.chat.id, "Активный проект не выбран. Используйте /project_set название");
    return null;
  }
  return project;
}

async function createTextEntity(env, table, entityType, projectId, text, authorId = null, source = "telegram") {
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
    source,
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
      "/comment id текст - добавить комментарий к задаче",
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
    await requestPendingInput(env, message.chat.id, "project_set", "Укажите название проекта следующим сообщением или одной командой: /project_set название");
    return;
  }

  const project = await setActiveProject(env.DB, message.chat.id, name);
  await clearPendingChatAction(env.DB, message.chat.id);
  await sendMessage(env, message.chat.id, `Активный проект: ${project.name}`);
}

async function requestPendingInput(env, chatId, action, prompt) {
  await setPendingChatAction(env.DB, chatId, action);
  await sendMessage(env, chatId, prompt);
}

function withCommandPayload(message, command, payload) {
  return {
    ...message,
    text: `/${command} ${payload}`,
    caption: "",
  };
}

async function handlePendingChatAction(env, message, user, ctx = null) {
  const action = await getPendingChatAction(env.DB, message.chat.id);
  if (!action) return false;

  const text = String(message.text || message.caption || "").trim();
  if (!text) return false;
  if (text.startsWith("/")) {
    await clearPendingChatAction(env.DB, message.chat.id);
    return false;
  }

  if (action === "project_set") {
    const project = await setActiveProject(env.DB, message.chat.id, text);
    await clearPendingChatAction(env.DB, message.chat.id);
    await sendMessage(env, message.chat.id, `Активный проект: ${project.name}`);
    return true;
  }

  const pendingMessage = withCommandPayload(message, action, text);
  await clearPendingChatAction(env.DB, message.chat.id);
  if (action === "idea") await handleIdea(env, pendingMessage, user);
  else if (action === "task") await handleTask(env, pendingMessage, user);
  else if (action === "note") await handleNote(env, pendingMessage, user);
  else if (action === "decision") await handleDecision(env, pendingMessage, user);
  else if (action === "link") await handleLink(env, pendingMessage, user);
  else if (action === "find") await handleFind(env, pendingMessage);
  else if (action === "comment") await handleComment(env, pendingMessage, user, ctx);
  else if (action === "task_doing") await handleTaskStatusCommand(env, pendingMessage, user, "doing", "task_doing", ctx);
  else if (action === "task_review") await handleTaskStatusCommand(env, pendingMessage, user, "review", "task_review", ctx);
  else if (action === "task_done") await handleTaskDone(env, pendingMessage, user, ctx);
  else {
    return false;
  }

  return true;
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
    await requestPendingInput(env, message.chat.id, "idea", "Отправьте текст идеи следующим сообщением или одной командой: /idea текст");
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const idea = await createTextEntity(env, "ideas", "idea", project.id, text, user?.id || null);
  await sendMessage(env, message.chat.id, `Идея #${idea.id} сохранена в проекте ${project.name}. Автор: ${user?.username || message.from.username || message.from.first_name || "—"}`, {
    reply_markup: entityActionKeyboard("idea", idea.id),
  });
}

async function handleTask(env, message, user) {
  const text = commandPayload(message);
  if (!text) {
    await requestPendingInput(env, message.chat.id, "task", "Отправьте текст задачи следующим сообщением или одной командой: /task текст");
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
    reply_markup: taskKeyboard(env, task.id, project.id, task.status || "todo"),
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
  if (!canTelegramWrite(user)) {
    await sendMessage(env, message.chat.id, "У вашей роли нет права менять статус задач.");
    return;
  }

  const payload = commandPayload(message);
  const taskId = Number.parseInt(payload, 10);
  if (!Number.isInteger(taskId)) {
    await requestPendingInput(env, message.chat.id, commandName, `Отправьте id задачи следующим сообщением или одной командой: /${commandName} 1`);
    return;
  }

  const project = await requireActiveProject(env, message);
  if (!project) return;
  const task = await getTelegramTask(env.DB, taskId);
  if (!task || task.is_deleted || task.project_id !== project.id) {
    await sendMessage(env, message.chat.id, "Задача не найдена в текущем проекте.");
    return;
  }
  if (task.status === status) {
    await sendMessage(env, message.chat.id, "Статус уже установлен.");
    return;
  }
  if (task.status === "done" && status !== "done") {
    await sendMessage(env, message.chat.id, "Завершённую задачу нельзя вернуть через Telegram-команду. Используйте web panel.");
    return;
  }

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

async function handleComment(env, message, user, ctx = null) {
  if (!canTelegramWrite(user)) {
    await sendMessage(env, message.chat.id, "У вашей роли нет права добавлять комментарии.");
    return;
  }
  const payload = commandPayload(message);
  const match = payload.match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) {
    await requestPendingInput(env, message.chat.id, "comment", "Отправьте id задачи и текст следующим сообщением: 42 текст комментария");
    return;
  }
  const taskId = Number.parseInt(match[1], 10);
  const body = match[2].trim();
  const task = await getTaskForComment(env.DB, taskId);
  if (!task || task.is_deleted) {
    await sendMessage(env, message.chat.id, "Задача не найдена.");
    return;
  }
  const activeProject = await getActiveProject(env.DB, message.chat.id);
  const crossProjectContext = Boolean(activeProject && activeProject.id !== task.project_id);
  const comment = await createTaskComment(env.DB, {
    taskId,
    authorUserId: user.id,
    body,
    source: "telegram",
    crossProjectContext,
  });
  await scheduleBackground(
    ctx,
    notifyMentionedUsers(env, {
      taskId,
      projectId: task.project_id,
      projectName: task.project_name,
      taskText: task.text,
      commentBody: comment.body,
      authorUserId: user.id,
      authorName: user.username,
    }),
  );
  const warning = crossProjectContext ? "\nВнимание: задача из другого проекта, не из активного проекта чата." : "";
  await sendMessage(env, message.chat.id, `Комментарий #${comment.id} добавлен к задаче #${taskId} (${task.project_name}).${warning}`, {
    reply_markup: taskKeyboard(env, task.id, task.project_id, task.status),
  });
}

async function handleTaskStatusCallback(env, callbackQuery, ctx = null) {
  const userId = callbackQuery.from?.id;
  if (!isAllowed(env, userId)) {
    await answerCallbackQuery(env, callbackQuery.id, "Доступ закрыт.");
    return;
  }

  const payload = parseTaskStatusCallback(callbackQuery.data);
  if (!payload) {
    await answerCallbackQuery(env, callbackQuery.id, "Неизвестное действие.");
    return;
  }

  const status = payload.status;
  const taskId = payload.taskId;
  const task = await getTelegramTask(env.DB, taskId);

  if (!task || task.is_deleted) {
    await answerCallbackQuery(env, callbackQuery.id, "Задача не найдена.");
    return;
  }

  const user = await findUserByTelegramId(env.DB, userId);
  if (!canTelegramWrite(user)) {
    await answerCallbackQuery(env, callbackQuery.id, "У вашей роли нет права менять статус задач.");
    return;
  }
  if (task.status === status) {
    await answerCallbackQuery(env, callbackQuery.id, "Статус уже установлен.");
    return;
  }
  if (task.status === "done" && status !== "done") {
    await answerCallbackQuery(env, callbackQuery.id, "Задача уже завершена.");
    return;
  }
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
      reply_markup: taskKeyboard(env, task.id, task.project_id, status),
    });
  }
}

async function handleEntityActionCallback(env, callbackQuery) {
  const userId = callbackQuery.from?.id;
  if (!isAllowed(env, userId)) {
    await answerCallbackQuery(env, callbackQuery.id, "Доступ закрыт.");
    return;
  }

  const payload = parseEntityActionCallback(callbackQuery.data);
  if (!payload) {
    await answerCallbackQuery(env, callbackQuery.id, "Неизвестное действие.");
    return;
  }

  const user = await findUserByTelegramId(env.DB, userId);
  if (!canTelegramWrite(user)) {
    await answerCallbackQuery(env, callbackQuery.id, "У вашей роли нет права выполнять действие.");
    return;
  }

  const label = payload.entityType === "idea" ? "Идея" : "Ссылка";
  try {
    if (payload.action === "convert_to_task") {
      const result = await convertEntityToTask(env.DB, {
        entityType: payload.entityType,
        entityId: payload.entityId,
        userId: user.id,
      });
      if (result.alreadyDeleted) {
        await answerCallbackQuery(env, callbackQuery.id, "Уже в архиве или обработано.");
        return;
      }
      await answerCallbackQuery(env, callbackQuery.id, `Создана задача #${result.task.id}`);
      const message = callbackQuery.message;
      if (message?.chat?.id && message.message_id) {
        await editMessageText(env, message.chat.id, message.message_id, `${label} #${payload.entityId} конвертирована в задачу #${result.task.id}.`, {
          reply_markup: taskKeyboard(env, result.task.id, result.task.project_id, result.task.status || "todo"),
        });
      }
      return;
    }

    const result = await archiveEntity(env.DB, {
      entityType: payload.entityType,
      entityId: payload.entityId,
      userId: user.id,
    });
    if (result.alreadyDeleted) {
      await answerCallbackQuery(env, callbackQuery.id, "Уже в архиве.");
      return;
    }
    await answerCallbackQuery(env, callbackQuery.id, "Отправлено в архив.");
    const message = callbackQuery.message;
    if (message?.chat?.id && message.message_id) {
      await editMessageText(env, message.chat.id, message.message_id, `${label} #${payload.entityId} отправлена в архив.`);
    }
  } catch (error) {
    console.error("Telegram entity action failed", error);
    await answerCallbackQuery(env, callbackQuery.id, "Не удалось выполнить действие.");
  }
}

async function handleCallbackQuery(env, callbackQuery, ctx = null) {
  if (parseTaskStatusCallback(callbackQuery.data)) {
    await handleTaskStatusCallback(env, callbackQuery, ctx);
    return;
  }
  if (parseEntityActionCallback(callbackQuery.data)) {
    await handleEntityActionCallback(env, callbackQuery);
    return;
  }
  await answerCallbackQuery(env, callbackQuery.id, "Неизвестное действие.");
}

async function handleNote(env, message, user) {
  const text = commandPayload(message);
  if (!text) {
    await requestPendingInput(env, message.chat.id, "note", "Отправьте текст заметки следующим сообщением или одной командой: /note текст");
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
    await requestPendingInput(env, message.chat.id, "decision", "Отправьте текст решения следующим сообщением или одной командой: /decision текст");
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
    await requestPendingInput(env, message.chat.id, "link", "Отправьте ссылку и описание следующим сообщением или одной командой: /link https://example.com описание");
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
  await sendMessage(env, message.chat.id, `Ссылка #${link.id} сохранена в проекте ${project.name}. Автор: ${user?.username || message.from.username || message.from.first_name || "—"}`, {
    reply_markup: entityActionKeyboard("link", link.id),
  });
}

async function saveAutoIntake(env, message, user, text, source = "telegram_auto") {
  const classified = classifyTelegramIntake(text);
  if (!classified) {
    await sendMessage(env, message.chat.id, "Не удалось определить текст для сохранения.");
    return;
  }
  if (classified.type === "project") {
    const project = await setActiveProject(env.DB, message.chat.id, classified.text);
    await sendMessage(env, message.chat.id, `Авто: активный проект: ${project.name}`);
    return;
  }
  if (classified.type === "list") {
    if (classified.listType === "projects") await handleProjects(env, message);
    else if (classified.listType === "tasks") await handleTasks(env, message);
    else if (classified.listType === "ideas") await handleEntityList(env, message, "ideas", "Идеи");
    else if (classified.listType === "notes") await handleEntityList(env, message, "notes", "Заметки");
    else if (classified.listType === "decisions") await handleEntityList(env, message, "decisions", "Решения");
    else if (classified.listType === "links") await handleEntityList(env, message, "links", "Ссылки");
    return;
  }
  if (classified.type === "find") {
    await handleFind(env, withCommandPayload(message, "find", classified.text));
    return;
  }
  if (classified.type === "comment") {
    await handleComment(env, withCommandPayload(message, "comment", `${classified.taskId} ${classified.text}`), user);
    return;
  }
  if (classified.type === "task_status") {
    const commandName = classified.status === "doing" ? "task_doing" : classified.status === "review" ? "task_review" : "task_done";
    await handleTaskStatusCommand(env, withCommandPayload(message, commandName, classified.taskId), user, classified.status, commandName);
    return;
  }
  const project = await requireActiveProject(env, message);
  if (!project) return;
  const authorName = user?.username || message.from.username || message.from.first_name || "—";

  if (classified.type === "link") {
    const link = await createLink(env.DB, {
      projectId: project.id,
      url: classified.url,
      description: classified.description,
      authorId: user?.id || null,
      source,
    });
    await sendMessage(env, message.chat.id, `Авто: ссылка #${link.id} сохранена в проекте ${project.name}. Автор: ${authorName}`, {
      reply_markup: entityActionKeyboard("link", link.id),
    });
    return;
  }

  if (classified.type === "idea") {
    const idea = await createTextEntity(env, "ideas", "idea", project.id, classified.text, user?.id || null, source);
    await sendMessage(env, message.chat.id, `Авто: идея #${idea.id} сохранена в проекте ${project.name}. Автор: ${authorName}`, {
      reply_markup: entityActionKeyboard("idea", idea.id),
    });
    return;
  }

  if (classified.type === "task") {
    const task = await createTask(env.DB, {
      projectId: project.id,
      text: classified.text,
      authorId: user?.id || null,
      source,
    });
    await sendMessage(env, message.chat.id, `Авто: ${taskSummary(task, project.name, authorName)}`, {
      reply_markup: taskKeyboard(env, task.id, project.id, task.status || "todo"),
    });
    return;
  }

  if (classified.type === "decision") {
    const decision = await createTextEntity(env, "decisions", "decision", project.id, classified.text, user?.id || null, source);
    await sendMessage(env, message.chat.id, `Авто: решение #${decision.id} сохранено в проекте ${project.name}. Автор: ${authorName}`);
    return;
  }

  const note = await createTextEntity(env, "notes", "note", project.id, classified.text, user?.id || null, source);
  await sendMessage(env, message.chat.id, `Авто: заметка #${note.id} сохранена в проекте ${project.name}. Автор: ${authorName}`);
}

function audioFileName(audio) {
  const name = String(audio.file_name || "").trim();
  if (name) return name;
  const mime = String(audio.mime_type || "");
  if (mime.includes("mpeg") || mime.includes("mp3")) return "telegram-audio.mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "telegram-audio.m4a";
  if (mime.includes("wav")) return "telegram-audio.wav";
  if (mime.includes("webm")) return "telegram-audio.webm";
  return "telegram-voice.ogg";
}

async function getTelegramFilePath(env, fileId) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok || !data.result?.file_path) {
    throw new Error("Telegram не вернул файл для транскрибации.");
  }
  return data.result.file_path;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function geminiTextFromResponse(data) {
  return String(data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "").trim();
}

async function transcribeWithGemini(env, audioBytes, mimeType) {
  if (audioBytes.byteLength > GEMINI_INLINE_AUDIO_LIMIT_BYTES) {
    throw new Error("Аудиофайл слишком большой для Gemini inline transcription. Максимум 18 MB.");
  }
  const model = env.GEMINI_TRANSCRIBE_MODEL || DEFAULT_GEMINI_TRANSCRIBE_MODEL;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: "Точно транскрибируй речь из аудио. Верни только текст транскрипции без пояснений." },
            {
              inline_data: {
                mime_type: mimeType || "audio/ogg",
                data: arrayBufferToBase64(audioBytes),
              },
            },
          ],
        },
      ],
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || "Gemini не смог выполнить транскрибацию.");
  }
  const text = geminiTextFromResponse(data);
  if (!text) {
    throw new Error("Gemini вернул пустую транскрибацию.");
  }
  return text;
}

async function transcribeWithOpenAI(env, audioBytes, audio) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OpenAI транскрибация не настроена.");
  }
  const form = new FormData();
  form.append("model", env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL);
  form.append("file", new Blob([audioBytes], { type: audio.mime_type || "audio/ogg" }), audioFileName(audio));
  form.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || "OpenAI не смог выполнить транскрибацию.";
    throw new Error(message);
  }
  const text = String(data?.text || "").trim();
  if (!text) {
    throw new Error("Транскрибация вернула пустой текст.");
  }
  return text;
}

async function transcribeTelegramAudio(env, audio) {
  if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) {
    throw new Error("Транскрибация не настроена. Добавьте GitHub secret GEMINI_API_KEY или OPENAI_API_KEY и перезапустите deploy.");
  }
  if (audio.file_size && Number(audio.file_size) > TELEGRAM_AUDIO_LIMIT_BYTES) {
    throw new Error("Аудиофайл слишком большой для транскрибации. Максимум 25 MB.");
  }
  const filePath = await getTelegramFilePath(env, audio.file_id);
  const audioResponse = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
  if (!audioResponse.ok) {
    throw new Error("Не удалось скачать аудио из Telegram.");
  }
  const audioBytes = await audioResponse.arrayBuffer();
  if (audioBytes.byteLength > TELEGRAM_AUDIO_LIMIT_BYTES) {
    throw new Error("Аудиофайл слишком большой для транскрибации. Максимум 25 MB.");
  }
  const mimeType = audio.mime_type || "audio/ogg";

  if (env.GEMINI_API_KEY && audioBytes.byteLength <= GEMINI_INLINE_AUDIO_LIMIT_BYTES) {
    try {
      return await transcribeWithGemini(env, audioBytes, mimeType);
    } catch (error) {
      if (!env.OPENAI_API_KEY) throw error;
      console.error("Gemini transcription failed, falling back to OpenAI", error);
    }
  }
  return await transcribeWithOpenAI(env, audioBytes, audio);
}

async function handleAudioIntake(env, message, user) {
  const audio = message.voice || message.audio;
  try {
    await sendMessage(env, message.chat.id, "Голос получен. Выполняю транскрибацию...");
    const text = await transcribeTelegramAudio(env, audio);
    await saveAutoIntake(env, message, user, text, "telegram_voice");
    await sendMessage(env, message.chat.id, `Транскрибация:\n${text}`);
  } catch (error) {
    console.error("Telegram audio transcription failed", error);
    await sendMessage(env, message.chat.id, error.message || "Не удалось обработать голосовое сообщение.");
  }
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
    await requestPendingInput(env, message.chat.id, "find", "Отправьте поисковый запрос следующим сообщением или одной командой: /find текст");
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
    await handleCallbackQuery(env, update.callback_query, ctx);
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
  if (await handlePendingChatAction(env, message, user, ctx)) {
    return;
  }

  if (message.voice || message.audio) {
    await handleAudioIntake(env, message, user);
    return;
  }

  const text = message.text || message.caption || "";
  if (text.trim() && !text.trim().startsWith("/")) {
    await saveAutoIntake(env, message, user, text);
    return;
  }
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
    case "/comment":
      await handleComment(env, message, user, ctx);
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
