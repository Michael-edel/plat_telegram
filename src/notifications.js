import { auditLog } from "./repository.js";
import { parseAllowedUsers, truncateText } from "./utils.js";

const DEFAULT_DUE_SOON_HOURS = 24;

function notificationWindowHours(env) {
  const value = Number.parseInt(env.TASK_DUE_SOON_HOURS || "", 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DUE_SOON_HOURS;
}

function notificationWindowDays(env) {
  return Math.max(1, Math.ceil(notificationWindowHours(env) / 24));
}

function isAllowedTelegramUser(env, telegramId) {
  if (!telegramId) return false;
  const allowedUsers = parseAllowedUsers(env.ALLOWED_USERS || "");
  return allowedUsers.size === 0 || allowedUsers.has(Number(telegramId));
}

async function sendTelegramMessage(env, chatId, text) {
  if (!env.BOT_TOKEN || !chatId) return false;
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
    console.error("Telegram notification failed", response.status, await response.text());
    return false;
  }
  return true;
}

async function notifyUser(env, user, text, auditDetails) {
  if (!user?.telegram_id || !isAllowedTelegramUser(env, user.telegram_id)) {
    return false;
  }
  const sent = await sendTelegramMessage(env, user.telegram_id, text);
  if (sent) {
    await auditLog(env.DB, {
      userId: user.id,
      action: "notification.sent",
      entityType: auditDetails.entityType,
      entityId: auditDetails.entityId,
      details: auditDetails.details,
    });
  }
  return sent;
}

async function notifyOverviewChat(env, text, auditDetails) {
  if (!env.TELEGRAM_NOTIFY_OVERVIEW_CHAT_ID) return false;
  const sent = await sendTelegramMessage(env, env.TELEGRAM_NOTIFY_OVERVIEW_CHAT_ID, text);
  if (sent) {
    await auditLog(env.DB, {
      action: "notification.sent",
      entityType: auditDetails.entityType,
      entityId: auditDetails.entityId,
      details: { ...auditDetails.details, target: "overview_chat" },
    });
  }
  return sent;
}

async function taskNotificationContext(db, taskId) {
  return await db
    .prepare(
      `SELECT t.id, t.text, t.status, t.priority, t.due_date, t.assignee_id, p.name AS project_name,
              u.id AS user_id, u.telegram_id, u.username, u.display_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.id = ? AND t.is_deleted = 0`,
    )
    .bind(taskId)
    .first();
}

function contextUser(row) {
  return row?.user_id ? { id: row.user_id, telegram_id: row.telegram_id, username: row.username, display_name: row.display_name } : null;
}

export async function notifyTaskAssigned(env, taskId, previousAssigneeId, nextAssigneeId) {
  if (!nextAssigneeId || String(previousAssigneeId || "") === String(nextAssigneeId || "")) return;
  const task = await taskNotificationContext(env.DB, taskId);
  const user = contextUser(task);
  await notifyUser(
    env,
    user,
    `Вам назначена задача #${task.id} в проекте ${task.project_name}: ${task.text} (${task.priority || "normal"}, дедлайн: ${task.due_date || "—"}).`,
    {
      entityType: "task",
      entityId: task.id,
      details: { type: "task.assigned", project: task.project_name },
    },
  );
}

export async function notifyTaskStatusChanged(env, taskId, oldStatus, newStatus) {
  if (oldStatus === newStatus) return;
  const task = await taskNotificationContext(env.DB, taskId);
  if (!task) return;
  const text = `Задача #${task.id} в проекте ${task.project_name} изменила статус: ${oldStatus} -> ${newStatus}.`;
  await notifyUser(env, contextUser(task), text, {
    entityType: "task",
    entityId: task.id,
    details: { type: "task.status_changed", old_status: oldStatus, new_status: newStatus, project: task.project_name },
  });
  await notifyOverviewChat(env, text, {
    entityType: "task",
    entityId: task.id,
    details: { type: "task.status_changed", old_status: oldStatus, new_status: newStatus, project: task.project_name },
  });
}

async function dueTaskRows(env, mode) {
  if (mode === "soon") {
    const days = notificationWindowDays(env);
    return await env.DB
      .prepare(
        `SELECT t.id, t.text, t.priority, t.due_date, p.name AS project_name,
                u.id AS user_id, u.telegram_id, u.username, u.display_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.is_deleted = 0
           AND t.status != 'done'
           AND t.due_date IS NOT NULL
           AND t.due_soon_notified_at IS NULL
           AND date(t.due_date) >= date('now')
           AND date(t.due_date) <= date('now', '+' || ? || ' days')
         ORDER BY t.due_date ASC
         LIMIT 50`,
      )
      .bind(days)
      .all();
  }
  return await env.DB
    .prepare(
      `SELECT t.id, t.text, t.priority, t.due_date, p.name AS project_name,
              u.id AS user_id, u.telegram_id, u.username, u.display_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.is_deleted = 0
         AND t.status != 'done'
         AND t.due_date IS NOT NULL
         AND t.overdue_notified_at IS NULL
         AND date(t.due_date) < date('now')
       ORDER BY t.due_date ASC
       LIMIT 50`,
    )
    .all();
}

export async function runTaskDeadlineNotifications(env) {
  const soon = await dueTaskRows(env, "soon");
  const overdue = await dueTaskRows(env, "overdue");
  let sent = 0;

  for (const task of soon.results) {
    const text = `Скоро дедлайн задачи #${task.id} (${task.project_name}): ${task.text}. Дедлайн: ${task.due_date}.`;
    const userSent = await notifyUser(env, contextUser(task), text, {
      entityType: "task",
      entityId: task.id,
      details: { type: "task.due_soon", due_date: task.due_date, project: task.project_name },
    });
    const overviewSent = await notifyOverviewChat(env, text, {
      entityType: "task",
      entityId: task.id,
      details: { type: "task.due_soon", due_date: task.due_date, project: task.project_name },
    });
    if (userSent || overviewSent) {
      sent += 1;
      await env.DB.prepare("UPDATE tasks SET due_soon_notified_at = datetime('now') WHERE id = ?").bind(task.id).run();
    }
  }

  for (const task of overdue.results) {
    const text = `Просрочена задача #${task.id} (${task.project_name}): ${task.text}. Дедлайн был ${task.due_date}.`;
    const userSent = await notifyUser(env, contextUser(task), text, {
      entityType: "task",
      entityId: task.id,
      details: { type: "task.overdue", due_date: task.due_date, project: task.project_name },
    });
    const overviewSent = await notifyOverviewChat(env, text, {
      entityType: "task",
      entityId: task.id,
      details: { type: "task.overdue", due_date: task.due_date, project: task.project_name },
    });
    if (userSent || overviewSent) {
      sent += 1;
      await env.DB.prepare("UPDATE tasks SET overdue_notified_at = datetime('now') WHERE id = ?").bind(task.id).run();
    }
  }

  return { checked: soon.results.length + overdue.results.length, sent };
}
