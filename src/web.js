import {
  ROLES,
  WRITE_ROLES,
  appendSetCookie,
  clearSessionCookie,
  createCsrfCookie,
  createCsrfToken,
  createSessionCookie,
  getCurrentUser,
  hashPassword,
  requireRole,
  roleLabel,
  verifyCsrfToken,
  verifyPassword,
} from "./auth.js";
import {
  ENTITY_CONFIG,
  TASK_PRIORITIES,
  addEntityTags,
  auditLog,
  changeLog,
  createTaskComment,
  createLink,
  createTask,
  createTextEntity,
  findUserByUsername,
  getProcessed1CEvent,
  getTaskComment,
  getOrCreateProject,
  getProject,
  getProjectByName,
  getUser,
  listAssignableUsers,
  listAudit,
  listDeletedEntities,
  listProjectChanges,
  listProjectAuthors,
  listProjectTags,
  listProjects,
  listUsers,
  loadProjectData,
  mark1CEventFailed,
  mark1CEventProcessed,
  reserve1CEvent,
  restoreEntity,
  searchProject,
  softDeleteLink,
  softDeleteTaskComment,
  softDeleteTask,
  softDeleteTextEntity,
  timezoneModifier,
  updateLink,
  updateTaskComment,
  updateTaskMeta,
  updateTaskStatus,
  updateTaskText,
  updateTextEntity,
} from "./repository.js";
import { notifyMentionedUsers, notifyTaskAssigned, notifyTaskStatusChanged, runTaskDeadlineNotifications } from "./notifications.js";
import { isTaskStatus, isValidUrl } from "./utils.js";

const ENTITY_PATHS = {
  ideas: ENTITY_CONFIG.ideas,
  notes: ENTITY_CONFIG.notes,
  decisions: ENTITY_CONFIG.decisions,
};
const LOGIN_RATE_LIMIT_WINDOW_MINUTES = 10;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 8;
const MAX_1C_BODY_BYTES = 64 * 1024;
const INTEGRATION_1C_USERNAME = "integration_1c";

function html(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function textResponse(body, contentType, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": contentType,
      ...(init.headers || {}),
    },
  });
}

async function scheduleBackground(ctx, promise) {
  if (ctx?.waitUntil) {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

function localDateString(env, daysOffset = 0) {
  const offset = Number.parseInt(env.APP_TIMEZONE_OFFSET_HOURS || "", 10);
  const offsetHours = Number.isInteger(offset) ? offset : 0;
  return new Date(Date.now() + (offsetHours * 60 * 60 + daysOffset * 24 * 60 * 60) * 1000).toISOString().slice(0, 10);
}

function likeEscape(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim() || "unknown";
}

async function isLoginRateLimited(env, ip) {
  if (!ip || ip === "unknown") {
    return false;
  }
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS count
       FROM audit_log
       WHERE action = 'login.failure'
         AND created_at >= datetime('now', '-' || ? || ' minutes')
         AND details_json LIKE ? ESCAPE '\\'`,
    )
    .bind(LOGIN_RATE_LIMIT_WINDOW_MINUTES, `%"ip":"${likeEscape(ip)}"%`)
    .first();
  return Number(row?.count || 0) >= LOGIN_RATE_LIMIT_MAX_FAILURES;
}

function redirect(location, headers = new Headers()) {
  headers.set("location", location);
  return new Response(null, { status: 303, headers });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function previewValue(value, maxLength = 240) {
  const text = String(value ?? "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function projectFileName(project, extension) {
  const safeName = String(project.name || "project").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "project";
  return `${safeName}.${extension}`;
}

function formatDate(value) {
  return value ? String(value).replace("T", " ").replace(/\.\d+Z$/, "") : "—";
}

function roleBadge(user) {
  return `<span class="badge role-${escapeHtml(user.role)}">${escapeHtml(roleLabel(user.role))}</span>`;
}

function canWrite(user) {
  return requireRole(user, WRITE_ROLES);
}

function isAdmin(user) {
  return requireRole(user, ["admin"]);
}

function canManageProjects(user) {
  return requireRole(user, ["admin", "manager"]);
}

function canManageComment(user, comment) {
  return Boolean(user && (["admin", "manager"].includes(user.role) || String(comment.author_user_id || "") === String(user.id)));
}

function dueSoonDays(env) {
  const hours = Number.parseInt(env.TASK_DUE_SOON_HOURS || "", 10);
  return Number.isInteger(hours) && hours > 0 ? Math.max(1, Math.ceil(hours / 24)) : 3;
}

function forbiddenResponse(isApi) {
  return isApi ? json({ error: "Forbidden" }, { status: 403 }) : renderErrorPage("Недостаточно прав", 403);
}

async function renderPage(env, user, { title, content }) {
  const csrfToken = await createCsrfToken(env);
  const headers = new Headers();
  appendSetCookie(headers, createCsrfCookie(csrfToken));
  return html(renderLayout({ title, content, user, csrfToken }), { headers });
}

function renderLayout({ title, content, user, csrfToken }) {
  const adminLinks = isAdmin(user)
    ? `<a href="/app/users">Пользователи</a><a href="/app/deleted">Удалённые</a><a href="/app/audit">Аудит</a>`
    : "";
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Project Panel</title>
  <style>
    :root {
      --bg: #f5f7fb;
      --surface: #ffffff;
      --surface-soft: #eef2f7;
      --border: #d9e0ea;
      --text: #172033;
      --muted: #687386;
      --accent: #2563eb;
      --accent-dark: #1d4ed8;
      --danger: #b42318;
      --ok: #067647;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.45;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 248px 1fr; }
    .sidebar { background: #111827; color: #f9fafb; padding: 22px 18px; }
    .brand { font-size: 18px; font-weight: 700; margin-bottom: 18px; }
    .user-box { border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 10px; margin-bottom: 18px; color: #d1d5db; }
    .nav { display: grid; gap: 6px; }
    .nav a, .logout-button {
      color: #d1d5db;
      padding: 9px 10px;
      border-radius: 8px;
      background: transparent;
      border: 0;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .nav a:hover, .logout-button:hover { background: rgba(255,255,255,.08); color: #fff; text-decoration: none; }
    .main { padding: 28px; overflow: auto; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
    h1, h2, h3 { margin: 0; line-height: 1.2; letter-spacing: 0; }
    h1 { font-size: 26px; }
    h2 { font-size: 18px; margin-bottom: 14px; }
    h3 { font-size: 15px; margin-bottom: 10px; }
    .muted { color: var(--muted); }
    .grid { display: grid; gap: 16px; }
    .grid.two { grid-template-columns: minmax(0, 1fr) minmax(320px, 420px); align-items: start; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .stat, .panel, .card, .task { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); }
    .stat { padding: 14px; }
    .stat strong { display: block; font-size: 24px; }
    .stat span { color: var(--muted); }
    .panel { padding: 18px; }
    .project-list, .items, .forms { display: grid; gap: 10px; }
    .project-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
    }
    .columns { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 12px; }
    .column { min-width: 0; background: var(--surface-soft); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
    .task, .card { padding: 12px; overflow-wrap: anywhere; }
    .task { margin-bottom: 10px; }
    .task.focused { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .14); }
    .task-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .task-comments, .task-activity { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; display: grid; gap: 8px; }
    .comment { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #fff; display: grid; gap: 6px; }
    h4 { margin: 0; font-size: 14px; letter-spacing: 0; }
    form.compact { display: grid; gap: 8px; }
    input, textarea, select {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: #ffffff;
      color: var(--text);
      padding: 9px 10px;
      font: inherit;
    }
    textarea { min-height: 84px; resize: vertical; }
    button, .button {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: 7px;
      background: var(--accent);
      color: #ffffff;
      padding: 8px 12px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
    }
    button:hover, .button:hover { background: var(--accent-dark); text-decoration: none; }
    .button.secondary, button.secondary { background: #ffffff; border-color: var(--border); color: var(--text); }
    .button.danger, button.danger { background: #fff; border-color: #f3b3ad; color: var(--danger); }
    .inline-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .inline-form select { min-width: 105px; }
    .search { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .filters { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)) auto; gap: 8px; align-items: end; margin-bottom: 12px; }
    .section-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #e5e7eb; color: #111827; }
    .notice { padding: 10px 12px; border: 1px solid #bfdbfe; background: #eff6ff; color: #1e3a8a; border-radius: 8px; margin-bottom: 12px; }
    .danger-badge { background: #fee4e2; color: #912018; }
    .warning-badge { background: #fef3c7; color: #92400e; }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .role-admin { background: #fee4e2; color: #912018; }
    .role-manager { background: #fef3c7; color: #92400e; }
    .role-editor { background: #dbeafe; color: #1e3a8a; }
    .role-viewer { background: #dcfce7; color: #14532d; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    @media (max-width: 1100px) {
      .shell { grid-template-columns: 1fr; }
      .grid.two, .section-grid, .columns, .stats, .filters { grid-template-columns: 1fr; }
      .main { padding: 18px; }
      .topbar { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">Project Panel</div>
      <div class="user-box">
        <div>${escapeHtml(user.display_name || user.username)}</div>
        <div>${roleBadge(user)}</div>
      </div>
      <nav class="nav" aria-label="Основная навигация">
        <a href="/app">Проекты</a>
        <a href="/app#tasks">Задачи</a>
        <a href="/app#ideas">Идеи</a>
        <a href="/app#notes">Заметки</a>
        <a href="/app#decisions">Решения</a>
        <a href="/app#links">Ссылки</a>
        <a href="/app#search">Поиск</a>
        ${adminLinks}
        <form method="post" action="/logout">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
          <button class="logout-button" type="submit">Выйти</button>
        </form>
      </nav>
    </aside>
    <main class="main">${content}</main>
  </div>
</body>
</html>`;
}

async function renderLogin(env, error = "") {
  const csrfToken = await createCsrfToken(env);
  const headers = new Headers();
  appendSetCookie(headers, createCsrfCookie(csrfToken));
  return html(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Вход · Project Panel</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f5f7fb; color:#172033; font-family:Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
    .box { width:min(420px, calc(100vw - 32px)); background:#fff; border:1px solid #d9e0ea; border-radius:8px; padding:24px; box-shadow:0 1px 2px rgba(15,23,42,.08); }
    h1 { margin:0 0 8px; font-size:24px; }
    p { margin:0 0 18px; color:#687386; }
    form { display:grid; gap:12px; }
    input { min-height:42px; border:1px solid #d9e0ea; border-radius:7px; padding:9px 10px; font:inherit; }
    button { min-height:42px; border:0; border-radius:7px; background:#2563eb; color:white; font:inherit; font-weight:600; cursor:pointer; }
    .error { color:#b42318; margin-bottom:12px; }
  </style>
</head>
<body>
  <section class="box">
    <h1>Вход</h1>
    <p>Внутренняя проектная панель.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/login">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      <input name="username" placeholder="Логин" autocomplete="username" required>
      <input name="password" type="password" placeholder="Пароль" autocomplete="current-password" required>
      <button type="submit">Войти</button>
    </form>
  </section>
</body>
</html>`, { headers });
}

function renderErrorPage(message, status = 400) {
  return html(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ошибка</title></head><body><h1>${escapeHtml(message)}</h1><p><a href="/app">Вернуться</a></p></body></html>`, { status });
}

async function readRequestData(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    return await request.json();
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

async function requireCsrf(request, env, data) {
  const token = data.csrf_token || request.headers.get("x-csrf-token");
  if (!(await verifyCsrfToken(request, env, token))) {
    throw new Error("CSRF validation failed");
  }
}

function projectRedirect(projectId, taskId = "") {
  const focus = taskId ? `?task=${encodeURIComponent(taskId)}` : "";
  return `/app/projects/${encodeURIComponent(projectId)}${focus}`;
}

function cleanFilter(value) {
  return String(value || "").trim();
}

function selected(value, current) {
  return String(value) === String(current || "") ? "selected" : "";
}

function renderTags(tags) {
  const values = String(tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return values.length ? `<div class="tags">${values.map((tag) => `<span class="badge">#${escapeHtml(tag)}</span>`).join("")}</div>` : "";
}

function projectFilterParams(url) {
  const status = cleanFilter(url.searchParams.get("status"));
  const authorId = Number.parseInt(url.searchParams.get("author_id") || "", 10);
  const assignee = cleanFilter(url.searchParams.get("assignee_id"));
  const assigneeId = assignee === "none" ? "none" : Number.parseInt(assignee || "", 10);
  const priority = cleanFilter(url.searchParams.get("priority"));
  const deadline = cleanFilter(url.searchParams.get("deadline"));
  const changeUserId = Number.parseInt(url.searchParams.get("change_user_id") || "", 10);
  const changeEntityType = cleanFilter(url.searchParams.get("change_entity_type"));
  const focusTaskId = Number.parseInt(url.searchParams.get("task") || "", 10);
  return {
    q: cleanFilter(url.searchParams.get("q")),
    status: isTaskStatus(status) ? status : "",
    authorId: Number.isInteger(authorId) ? authorId : "",
    priority: TASK_PRIORITIES.includes(priority) ? priority : "",
    assigneeId: assigneeId === "none" || Number.isInteger(assigneeId) ? assigneeId : "",
    deadline: ["", "none", "today", "week", "overdue"].includes(deadline) ? deadline : "",
    changeUserId: Number.isInteger(changeUserId) ? changeUserId : "",
    changeEntityType: ["", "task", "idea", "note", "decision", "link"].includes(changeEntityType) ? changeEntityType : "",
    focusTaskId: Number.isInteger(focusTaskId) && focusTaskId > 0 ? focusTaskId : "",
    tag: cleanFilter(url.searchParams.get("tag")).replace(/^#/, "").toLowerCase(),
  };
}

function renderDashboard(projects, user, csrfToken, riskWindowDays) {
  const totals = projects.reduce(
    (acc, project) => {
      acc.todo += Number(project.todo_count || 0);
      acc.doing += Number(project.doing_count || 0);
      acc.review += Number(project.review_count || 0);
      acc.done += Number(project.done_count || 0);
      acc.ideas += Number(project.ideas_count || 0);
      acc.notes += Number(project.notes_count || 0);
      acc.decisions += Number(project.decisions_count || 0);
      acc.links += Number(project.links_count || 0);
      acc.overdue += Number(project.overdue_count || 0);
      acc.dueSoon += Number(project.due_soon_count || 0);
      return acc;
    },
    { todo: 0, doing: 0, review: 0, done: 0, ideas: 0, notes: 0, decisions: 0, links: 0, overdue: 0, dueSoon: 0 },
  );

  const projectRows = projects.length
    ? projects
        .map(
          (project) => `<article class="project-row">
            <div>
              <h3>${escapeHtml(project.name)}</h3>
              <p class="muted">Задачи: todo ${Number(project.todo_count || 0)}, doing ${Number(project.doing_count || 0)}, review ${Number(project.review_count || 0)}, done ${Number(project.done_count || 0)}</p>
              <p class="muted">Идеи ${Number(project.ideas_count || 0)} · Заметки ${Number(project.notes_count || 0)} · Решения ${Number(project.decisions_count || 0)} · Ссылки ${Number(project.links_count || 0)}</p>
              <p>${Number(project.overdue_count || 0) ? `<span class="badge danger-badge">Просрочено: ${Number(project.overdue_count || 0)}</span>` : `<span class="badge">Просрочено: 0</span>`} <span class="badge">Дедлайн ≤ ${riskWindowDays} дн.: ${Number(project.due_soon_count || 0)}</span></p>
            </div>
            <a class="button" href="/app/projects/${project.id}">Открыть</a>
          </article>`,
        )
        .join("")
    : `<p class="muted">Проектов пока нет.</p>`;

  const createPanel = canManageProjects(user)
    ? `<section class="panel">
        <h2>Создать проект</h2>
        <form class="compact" method="post" action="/app/projects">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
          <input name="name" placeholder="Название проекта" required>
          <button type="submit">Создать</button>
        </form>
      </section>`
    : `<section class="panel"><h2>Создание проекта</h2><p class="muted">Доступно только admin и manager.</p></section>`;

  return `<div class="topbar">
      <div><h1>Проекты</h1><p class="muted">Рабочая панель проектной базы.</p></div>
    </div>
    <section class="stats">
      <div class="stat"><strong>${totals.todo}</strong><span>todo</span></div>
      <div class="stat"><strong>${totals.doing}</strong><span>doing</span></div>
      <div class="stat"><strong>${totals.review}</strong><span>review</span></div>
      <div class="stat"><strong>${totals.done}</strong><span>done</span></div>
      <div class="stat"><strong>${totals.ideas}</strong><span>идей</span></div>
      <div class="stat"><strong>${totals.notes}</strong><span>заметок</span></div>
      <div class="stat"><strong>${totals.decisions}</strong><span>решений</span></div>
      <div class="stat"><strong>${totals.links}</strong><span>ссылок</span></div>
      <div class="stat"><strong>${totals.overdue}</strong><span>просрочено</span></div>
      <div class="stat"><strong>${totals.dueSoon}</strong><span>дедлайн ≤ ${riskWindowDays} дн.</span></div>
    </section>
    <div class="grid two">
      <section class="panel"><h2>Список проектов</h2><div class="project-list">${projectRows}</div></section>
      ${createPanel}
    </div>`;
}

function entityMeta(item) {
  return `<div class="muted">Автор: ${escapeHtml(item.author_name || "—")} · Создано: ${escapeHtml(formatDate(item.created_at))} · Обновлено: ${escapeHtml(formatDate(item.updated_at))}</div>`;
}

function assigneeName(task) {
  return task.assignee_display_name || task.assignee_username || "";
}

function renderAssigneeOptions(assignableUsers, currentId = "") {
  return [{ id: "", username: "Без ответственного" }, ...assignableUsers]
    .map((item) => {
      const name = item.display_name || item.username;
      return `<option value="${item.id}" ${selected(item.id, currentId)}>${escapeHtml(name)}</option>`;
    })
    .join("");
}

function activityText(row) {
  if (row.event_type === "comment_added") return `${row.user_name} добавил комментарий: ${row.new_value || ""}`;
  if (row.event_type === "comment_edited") return `${row.user_name} изменил комментарий`;
  if (row.event_type === "comment_deleted") return `${row.user_name} удалил комментарий`;
  if (row.field_name === "created") return `${row.user_name} создал задачу`;
  if (row.field_name === "deleted") return `${row.user_name} удалил задачу`;
  return `${row.user_name} изменил ${row.field_name}: ${row.old_value || "—"} -> ${row.new_value || "—"}`;
}

function renderTaskActivities(rows) {
  if (!rows.length) return `<p class="muted">Активности пока нет.</p>`;
  return `<div class="activity">${rows
    .slice(0, 8)
    .map((row) => `<div class="muted">${escapeHtml(formatDate(row.created_at))} · ${escapeHtml(activityText(row))}</div>`)
    .join("")}</div>`;
}

function renderTaskComments(task, comments, user, csrfToken) {
  const rows = comments.length
    ? comments
        .map((comment) => {
          const actions = canManageComment(user, comment)
            ? `<form class="compact" method="post" action="/app/comments/${comment.id}/edit">
                <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
                <textarea name="body" required>${escapeHtml(comment.body)}</textarea>
                <button class="secondary" type="submit">Сохранить комментарий</button>
              </form>
              <form method="post" action="/app/comments/${comment.id}/delete">
                <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
                <button class="danger" type="submit">Удалить комментарий</button>
              </form>`
            : "";
          return `<article class="comment">
            <div>${escapeHtml(comment.body)}</div>
            <div class="muted">${escapeHtml(comment.author_name || "—")} · ${escapeHtml(formatDate(comment.created_at))}</div>
            ${actions}
          </article>`;
        })
        .join("")
    : `<p class="muted">Комментариев пока нет.</p>`;
  const form = canWrite(user)
    ? `<form class="compact" method="post" action="/app/tasks/${task.id}/comments">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <textarea name="body" placeholder="Комментарий к задаче" required></textarea>
        <button class="secondary" type="submit">Добавить комментарий</button>
      </form>`
    : "";
  return `<div class="task-comments"><h4>Комментарии</h4>${rows}${form}</div>`;
}

function renderTask(task, projectId, user, csrfToken, assignableUsers, focusTaskId = "", comments = [], activities = []) {
  const options = ["todo", "doing", "review", "done"]
    .map((status) => `<option value="${status}" ${task.status === status ? "selected" : ""}>${status}</option>`)
    .join("");
  const priorityOptions = TASK_PRIORITIES.map((priority) => `<option value="${priority}" ${selected(priority, task.priority)}>${priority}</option>`).join("");
  const actions = canWrite(user)
    ? `<form class="inline-form" method="post" action="/app/tasks/${task.id}/status">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="project_id" value="${projectId}">
        <select name="status">${options}</select>
        <button class="secondary" type="submit">OK</button>
      </form>
      <form class="compact" method="post" action="/app/tasks/${task.id}/meta">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="project_id" value="${projectId}">
        <select name="priority">${priorityOptions}</select>
        <input name="due_date" type="date" value="${escapeHtml(task.due_date || "")}">
        <select name="assignee_id">${renderAssigneeOptions(assignableUsers, task.assignee_id || "")}</select>
        <button class="secondary" type="submit">Поля</button>
      </form>
      <form class="compact" method="post" action="/app/tasks/${task.id}/edit">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="project_id" value="${projectId}">
        <textarea name="text" required>${escapeHtml(task.text)}</textarea>
        <button class="secondary" type="submit">Сохранить</button>
      </form>
      <form method="post" action="/app/tasks/${task.id}/delete">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="project_id" value="${projectId}">
        <button class="danger" type="submit">Удалить</button>
      </form>`
    : "";
  const isFocused = String(task.id) === String(focusTaskId || "");
  return `<article class="task ${isFocused ? "focused" : ""}" id="task-${task.id}">
    <div>#${task.id} ${escapeHtml(task.text)}</div>
    ${renderTags(task.tags)}
    <div class="muted">Приоритет: ${escapeHtml(task.priority || "normal")} · Дедлайн: ${escapeHtml(task.due_date || "—")} · Ответственный: ${escapeHtml(assigneeName(task) || "—")}</div>
    ${entityMeta(task)}
    <div class="task-footer">${actions}</div>
    ${renderTaskComments(task, comments, user, csrfToken)}
    <div class="task-activity"><h4>Активность</h4>${renderTaskActivities(activities)}</div>
  </article>`;
}

function renderTextCards(items, path, projectId, user, csrfToken) {
  if (!items.length) {
    return `<p class="muted">Нет записей.</p>`;
  }
  return items
    .map((item) => {
      const actions = canWrite(user)
        ? `<form class="compact" method="post" action="/app/${path}/${item.id}/edit">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="project_id" value="${projectId}">
            <textarea name="text" required>${escapeHtml(item.text)}</textarea>
            <button class="secondary" type="submit">Сохранить</button>
          </form>
          <form method="post" action="/app/${path}/${item.id}/delete">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="project_id" value="${projectId}">
            <button class="danger" type="submit">Удалить</button>
          </form>`
        : "";
      return `<article class="card"><div>#${item.id} ${escapeHtml(item.text)}</div>${renderTags(item.tags)}${entityMeta(item)}${actions}</article>`;
    })
    .join("");
}

function renderLinks(items, projectId, user, csrfToken) {
  if (!items.length) {
    return `<p class="muted">Нет ссылок.</p>`;
  }
  return items
    .map((item) => {
      const actions = canWrite(user)
        ? `<form class="compact" method="post" action="/app/links/${item.id}/edit">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="project_id" value="${projectId}">
            <input name="url" value="${escapeHtml(item.url)}" required>
            <input name="description" value="${escapeHtml(item.description || "")}">
            <button class="secondary" type="submit">Сохранить</button>
          </form>
          <form method="post" action="/app/links/${item.id}/delete">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="project_id" value="${projectId}">
            <button class="danger" type="submit">Удалить</button>
          </form>`
        : "";
      return `<article class="card">
        <div><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a></div>
        <div>${escapeHtml(item.description || "")}</div>
        ${renderTags(item.tags)}
        ${entityMeta(item)}
        ${actions}
      </article>`;
    })
    .join("");
}

function renderSearchResults(results, query) {
  if (!query) return "";
  if (!results.length) return `<div class="card">Ничего не найдено.</div>`;
  return `<div class="items">${results
    .map((item) => `<article class="card"><strong>${escapeHtml(item.kind)} #${item.id}</strong><div>${escapeHtml(item.text)}</div></article>`)
    .join("")}</div>`;
}

function renderChangeLog(rows, projectId, filters, authors) {
  const entityOptions = ["", "task", "idea", "note", "decision", "link"]
    .map((type) => `<option value="${type}" ${selected(type, filters.changeEntityType)}>${type || "Все типы"}</option>`)
    .join("");
  const userOptions = [{ id: "", name: "Все пользователи" }, ...authors]
    .map((author) => `<option value="${author.id}" ${selected(author.id, filters.changeUserId)}>${escapeHtml(author.name)}</option>`)
    .join("");
  const filterForm = `<form class="filters" method="get" action="/app/projects/${projectId}">
    <input type="hidden" name="status" value="${escapeHtml(filters.status)}">
    <input type="hidden" name="priority" value="${escapeHtml(filters.priority)}">
    <input type="hidden" name="author_id" value="${escapeHtml(filters.authorId)}">
    <input type="hidden" name="assignee_id" value="${escapeHtml(filters.assigneeId)}">
    <input type="hidden" name="deadline" value="${escapeHtml(filters.deadline)}">
    <input type="hidden" name="tag" value="${escapeHtml(filters.tag)}">
    <input type="hidden" name="q" value="${escapeHtml(filters.q)}">
    <label>Тип<select name="change_entity_type">${entityOptions}</select></label>
    <label>Пользователь<select name="change_user_id">${userOptions}</select></label>
    <button type="submit">История</button>
  </form>`;
  if (!rows.length) {
    return `${filterForm}<p class="muted">Истории изменений пока нет.</p>`;
  }
  return `${filterForm}<table><thead><tr><th>Дата</th><th>Кто</th><th>Сущность</th><th>Поле</th><th>Было</th><th>Стало</th></tr></thead><tbody>${rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(formatDate(row.created_at))}</td>
        <td>${escapeHtml(row.username || "—")}</td>
        <td>${escapeHtml(row.entity_type)} #${row.entity_id}</td>
        <td>${escapeHtml(row.field_name)}</td>
        <td>${escapeHtml(row.old_value || "—")}</td>
        <td>${escapeHtml(row.new_value || "—")}</td>
      </tr>`,
    )
    .join("")}</tbody></table>`;
}

function renderCreateForms(projectId, user, csrfToken, assignableUsers) {
  if (!canWrite(user)) {
    return `<section class="panel"><h2>Добавить запись</h2><p class="muted">У вашей роли доступ только на чтение.</p></section>`;
  }
  return `<section class="panel">
    <h2>Добавить запись</h2>
    <div class="forms">
      <form class="compact" method="post" action="/app/tasks">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="project_id" value="${projectId}">
        <textarea name="text" placeholder="Новая задача" required></textarea>
        <select name="priority">${TASK_PRIORITIES.map((priority) => `<option value="${priority}" ${selected(priority, "normal")}>${priority}</option>`).join("")}</select>
        <input name="due_date" type="date">
        <select name="assignee_id">${renderAssigneeOptions(assignableUsers)}</select>
        <button type="submit">Создать задачу</button>
      </form>
      ${Object.entries(ENTITY_PATHS)
        .map(
          ([path, config]) => `<form class="compact" method="post" action="/app/${path}">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="project_id" value="${projectId}">
            <textarea name="text" placeholder="${escapeHtml(config.single)}" required></textarea>
            <button type="submit">Сохранить</button>
          </form>`,
        )
        .join("")}
      <form class="compact" method="post" action="/app/links">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="project_id" value="${projectId}">
        <input name="url" placeholder="https://example.com" required>
        <input name="description" placeholder="Описание ссылки">
        <button type="submit">Сохранить ссылку</button>
      </form>
    </div>
  </section>`;
}

function renderProject(project, data, searchResults, filters, filterOptions, user, csrfToken) {
  const query = filters.q || "";
  const statusOptions = ["", "todo", "doing", "review", "done"]
    .map((status) => `<option value="${status}" ${selected(status, filters.status)}>${status || "Все статусы"}</option>`)
    .join("");
  const priorityOptions = ["", ...TASK_PRIORITIES]
    .map((priority) => `<option value="${priority}" ${selected(priority, filters.priority)}>${priority || "Все приоритеты"}</option>`)
    .join("");
  const authorOptions = [{ id: "", name: "Все авторы" }, ...filterOptions.authors]
    .map((author) => `<option value="${author.id}" ${selected(author.id, filters.authorId)}>${escapeHtml(author.name)}</option>`)
    .join("");
  const assigneeOptions = [{ id: "", name: "Все ответственные" }, { id: "none", name: "Без ответственного" }, ...filterOptions.assignableUsers]
    .map((item) => `<option value="${item.id}" ${selected(item.id, filters.assigneeId)}>${escapeHtml(item.name || item.display_name || item.username)}</option>`)
    .join("");
  const deadlineOptions = [
    ["", "Все дедлайны"],
    ["none", "Без дедлайна"],
    ["today", "Сегодня"],
    ["week", "На этой неделе"],
    ["overdue", "Просроченные"],
  ]
    .map(([value, label]) => `<option value="${value}" ${selected(value, filters.deadline)}>${label}</option>`)
    .join("");
  const tagOptions = [{ name: "" }, ...filterOptions.tags]
    .map((tag) => `<option value="${escapeHtml(tag.name)}" ${selected(tag.name, filters.tag)}>${tag.name ? `#${escapeHtml(tag.name)}` : "Все теги"}</option>`)
    .join("");
  const commentsByTask = new Map();
  for (const comment of data.taskComments || []) {
    if (!commentsByTask.has(comment.task_id)) commentsByTask.set(comment.task_id, []);
    commentsByTask.get(comment.task_id).push(comment);
  }
  const activitiesByTask = new Map();
  for (const activity of data.taskActivities || []) {
    if (!activitiesByTask.has(activity.task_id)) activitiesByTask.set(activity.task_id, []);
    activitiesByTask.get(activity.task_id).push(activity);
  }
  const taskColumns = ["todo", "doing", "review", "done"]
    .map((status) => {
      const tasks = data.tasks.filter((task) => task.status === status);
      return `<section class="column"><h3>${status}</h3>${
        tasks.length
          ? tasks
              .map((task) =>
                renderTask(
                  task,
                  project.id,
                  user,
                  csrfToken,
                  filterOptions.assignableUsers,
                  filters.focusTaskId,
                  commentsByTask.get(task.id) || [],
                  activitiesByTask.get(task.id) || [],
                ),
              )
              .join("")
          : `<p class="muted">Нет задач.</p>`
      }</section>`;
    })
    .join("");
  const focusedTaskExists = filters.focusTaskId ? data.tasks.some((task) => String(task.id) === String(filters.focusTaskId)) : true;
  const focusNotice = filters.focusTaskId && !focusedTaskExists ? `<div class="notice">Задача #${escapeHtml(filters.focusTaskId)} не найдена в этом проекте или скрыта текущими фильтрами.</div>` : "";
  const focusScript = filters.focusTaskId && focusedTaskExists ? `<script>document.getElementById("task-${Number(filters.focusTaskId)}")?.scrollIntoView({ block: "center" });</script>` : "";
  const overdueCount = data.tasks.filter((task) => task.status !== "done" && task.due_date && task.due_date < filterOptions.today).length;
  const dueSoonCount = data.tasks.filter(
    (task) => task.status !== "done" && task.due_date && task.due_date >= filterOptions.today && task.due_date <= filterOptions.dueSoonDate,
  ).length;

  return `<div class="topbar">
      <div><h1>${escapeHtml(project.name)}</h1><p class="muted">Создан: ${escapeHtml(formatDate(project.created_at))}</p></div>
      <div class="inline-form"><a class="button secondary" href="/app">Все проекты</a><a class="button secondary" href="/app/projects/${project.id}/export.md">Markdown</a><a class="button secondary" href="/app/projects/${project.id}/export.csv">CSV</a><a class="button secondary" href="/app/projects/${project.id}/export.json">JSON</a></div>
    </div>
    <section class="panel" id="search">
      ${focusNotice}
      <div class="inline-form" style="margin-bottom:12px">
        <span class="badge ${overdueCount ? "danger-badge" : ""}">Просрочено: ${overdueCount}</span>
        <span class="badge ${dueSoonCount ? "warning-badge" : ""}">Дедлайн ≤ ${filterOptions.riskWindowDays} дн.: ${dueSoonCount}</span>
      </div>
      <h2>Фильтры и поиск</h2>
      <form class="filters" method="get" action="/app/projects/${project.id}">
        <label>Статус<select name="status">${statusOptions}</select></label>
        <label>Приоритет<select name="priority">${priorityOptions}</select></label>
        <label>Автор<select name="author_id">${authorOptions}</select></label>
        <label>Ответственный<select name="assignee_id">${assigneeOptions}</select></label>
        <label>Дедлайн<select name="deadline">${deadlineOptions}</select></label>
        <label>Тег<select name="tag">${tagOptions}</select></label>
        <label>Поиск<input name="q" value="${escapeHtml(query)}" placeholder="Текст"></label>
        <button type="submit">Найти</button>
      </form>
      <a class="button secondary" href="/app/projects/${project.id}">Сбросить</a>
      ${renderSearchResults(searchResults, query)}
    </section>
    <div class="grid two" style="margin-top:16px">
      <div class="grid">
        <section class="panel" id="tasks"><h2>Задачи</h2><div class="columns">${taskColumns}</div></section>
        <section class="panel" id="changes"><h2>История изменений</h2>${renderChangeLog(filterOptions.changes, project.id, filters, filterOptions.authors)}</section>
        <div class="section-grid">
          <section class="panel" id="ideas"><h2>Идеи</h2><div class="items">${renderTextCards(data.ideas, "ideas", project.id, user, csrfToken)}</div></section>
          <section class="panel" id="notes"><h2>Заметки</h2><div class="items">${renderTextCards(data.notes, "notes", project.id, user, csrfToken)}</div></section>
          <section class="panel" id="decisions"><h2>Решения</h2><div class="items">${renderTextCards(data.decisions, "decisions", project.id, user, csrfToken)}</div></section>
          <section class="panel" id="links"><h2>Ссылки</h2><div class="items">${renderLinks(data.links, project.id, user, csrfToken)}</div></section>
        </div>
      </div>
      ${renderCreateForms(project.id, user, csrfToken, filterOptions.assignableUsers)}
    </div>${focusScript}`;
}

function renderUsersPage(users, filters, csrfToken) {
  const rows = users
    .map(
      (user) => `<tr>
        <td>${user.id}</td>
        <td>${escapeHtml(user.username)}<br><span class="muted">${escapeHtml(user.display_name || "")}</span></td>
        <td>${roleBadge(user)}</td>
        <td>${escapeHtml(user.telegram_id || "—")}</td>
        <td>${escapeHtml(formatDate(user.last_login_at))}</td>
        <td>${user.is_active ? "активен" : "отключён"}</td>
        <td>
          <form class="inline-form" method="post" action="/app/users/${user.id}/role">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <select name="role">
              ${ROLES.map((role) => `<option value="${role}" ${user.role === role ? "selected" : ""}>${role}</option>`).join("")}
            </select>
            <button class="secondary">Роль</button>
          </form>
          <form class="inline-form" method="post" action="/app/users/${user.id}/status">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="is_active" value="${user.is_active ? "0" : "1"}">
            <button class="secondary">${user.is_active ? "Отключить" : "Включить"}</button>
          </form>
          <form class="inline-form" method="post" action="/app/users/${user.id}/password">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input name="password" type="password" placeholder="Новый пароль" required>
            <button class="secondary">Пароль</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  return `<div class="topbar"><h1>Пользователи</h1><a class="button secondary" href="/app">Проекты</a></div>
    <section class="panel" style="margin-bottom:16px">
      <h2>Фильтры</h2>
      <form class="filters" method="get" action="/app/users">
        <label>Роль<select name="role">
          <option value="">Все роли</option>
          ${ROLES.map((role) => `<option value="${role}" ${selected(role, filters.role)}>${role}</option>`).join("")}
        </select></label>
        <label>Статус<select name="active">
          <option value="">Все</option>
          <option value="1" ${selected("1", filters.active)}>Активные</option>
          <option value="0" ${selected("0", filters.active)}>Отключённые</option>
        </select></label>
        <button type="submit">Применить</button>
        <a class="button secondary" href="/app/users">Сбросить</a>
      </form>
    </section>
    <div class="grid two">
      <section class="panel">
        <h2>Список пользователей</h2>
        <table><thead><tr><th>ID</th><th>Пользователь</th><th>Роль</th><th>Telegram ID</th><th>Последний вход</th><th>Статус</th><th>Действия</th></tr></thead><tbody>${rows}</tbody></table>
      </section>
      <section class="panel">
        <h2>Создать пользователя</h2>
        <form class="compact" method="post" action="/app/users">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
          <input name="username" placeholder="Логин" required>
          <input name="display_name" placeholder="Имя">
          <input name="telegram_id" placeholder="Telegram ID">
          <select name="role">${ROLES.map((role) => `<option value="${role}">${role}</option>`).join("")}</select>
          <input name="password" type="password" placeholder="Пароль" required>
          <button type="submit">Создать</button>
        </form>
      </section>
    </div>`;
}

function renderAuditPage(rows, filters) {
  const body = rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(formatDate(row.created_at))}</td>
        <td>${escapeHtml(row.username || "—")}</td>
        <td>${escapeHtml(row.action)}</td>
        <td>${escapeHtml(row.entity_type || "—")} ${row.entity_id || ""}</td>
        <td><code>${escapeHtml(row.details_json || "")}</code></td>
      </tr>`,
    )
    .join("");
  return `<div class="topbar"><h1>Аудит</h1><a class="button secondary" href="/app">Проекты</a></div>
    <section class="panel" style="margin-bottom:16px">
      <h2>Фильтры</h2>
      <form class="filters" method="get" action="/app/audit">
        <label>User ID<input name="user_id" value="${escapeHtml(filters.userId || "")}" placeholder="ID"></label>
        <label>Действие<input name="action" value="${escapeHtml(filters.action || "")}" placeholder="login, task"></label>
        <label>Тип<select name="entity_type">
          <option value="">Все</option>
          ${["project", "task", "idea", "note", "decision", "link", "user"].map((type) => `<option value="${type}" ${selected(type, filters.entityType)}>${type}</option>`).join("")}
        </select></label>
        <button type="submit">Применить</button>
        <a class="button secondary" href="/app/audit">Сбросить</a>
      </form>
    </section>
    <section class="panel">
      <table><thead><tr><th>Дата</th><th>Пользователь</th><th>Действие</th><th>Сущность</th><th>Детали</th></tr></thead><tbody>${body}</tbody></table>
    </section>`;
}

function renderDeletedPage(rows, csrfToken) {
  const body = rows.length
    ? rows
        .map(
          (row) => `<tr>
            <td>${escapeHtml(formatDate(row.deleted_at))}</td>
            <td>${escapeHtml(row.project_name)}</td>
            <td>${escapeHtml(row.entity_type)} #${row.id}</td>
            <td>${escapeHtml(row.title)}</td>
            <td>${escapeHtml(row.author_name || "—")}</td>
            <td>
              <form method="post" action="/app/deleted/${encodeURIComponent(row.entity_type)}/${row.id}/restore">
                <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
                <button class="secondary" type="submit">Восстановить</button>
              </form>
            </td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="muted">Удалённых записей нет.</td></tr>`;

  return `<div class="topbar"><h1>Удалённые записи</h1><a class="button secondary" href="/app">Проекты</a></div>
    <section class="panel">
      <table><thead><tr><th>Удалено</th><th>Проект</th><th>Тип</th><th>Текст</th><th>Автор</th><th>Действие</th></tr></thead><tbody>${body}</tbody></table>
    </section>`;
}

function projectMarkdown(project, data) {
  const lines = [`# ${project.name}`, "", `Создан: ${formatDate(project.created_at)}`, "", "## Задачи"];
  for (const task of data.tasks) {
    lines.push(
      `- [${task.status}] #${task.id} ${task.text} (priority: ${task.priority || "normal"}, due: ${task.due_date || "-"}, assignee: ${assigneeName(task) || "-"})`,
    );
  }
  for (const [title, items, formatter] of [
    ["Идеи", data.ideas, (item) => `#${item.id} ${item.text}`],
    ["Заметки", data.notes, (item) => `#${item.id} ${item.text}`],
    ["Решения", data.decisions, (item) => `#${item.id} ${item.text}`],
    ["Ссылки", data.links, (item) => `#${item.id} ${item.url}${item.description ? ` - ${item.description}` : ""}`],
  ]) {
    lines.push("", `## ${title}`);
    lines.push(...(items.length ? items.map((item) => `- ${formatter(item)}`) : ["-"]));
  }
  return `${lines.join("\n")}\n`;
}

function projectCsv(project, data) {
  const rows = [["project", "type", "id", "status", "priority", "due_date", "assignee", "text", "url", "created_at", "updated_at"]];
  for (const task of data.tasks) {
    rows.push([project.name, "task", task.id, task.status, task.priority, task.due_date, assigneeName(task), task.text, "", task.created_at, task.updated_at]);
  }
  for (const [type, items] of [
    ["idea", data.ideas],
    ["note", data.notes],
    ["decision", data.decisions],
  ]) {
    for (const item of items) rows.push([project.name, type, item.id, "", "", "", item.author_name, item.text, "", item.created_at, item.updated_at]);
  }
  for (const item of data.links) {
    rows.push([project.name, "link", item.id, "", "", "", item.author_name, item.description || "", item.url, item.created_at, item.updated_at]);
  }
  return `${rows.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}

async function handleProjectExport(env, user, projectId, format) {
  const project = await getProject(env.DB, projectId);
  if (!project) return renderErrorPage("Проект не найден", 404);
  const data = await loadProjectData(env.DB, projectId, {}, timezoneModifier(env));
  const headers = new Headers();
  if (format === "json") {
    headers.set("content-disposition", `attachment; filename="${projectFileName(project, "json")}"`);
    return json({ project, data }, { headers });
  }
  if (format === "csv") {
    headers.set("content-disposition", `attachment; filename="${projectFileName(project, "csv")}"`);
    return textResponse(projectCsv(project, data), "text/csv; charset=utf-8", { headers });
  }
  headers.set("content-disposition", `attachment; filename="${projectFileName(project, "md")}"`);
  return textResponse(projectMarkdown(project, data), "text/markdown; charset=utf-8", { headers });
}

function oneCJson(data, status = 200) {
  return json(data, { status });
}

async function readOneCEvent(request) {
  const body = await request.text();
  const size = new TextEncoder().encode(body).byteLength;
  if (size > MAX_1C_BODY_BYTES) {
    throw new Error("Payload is too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON");
  }
}

function validateOneCEnvelope(event) {
  const eventId = String(event?.event_id || "").trim();
  if (eventId.length < 8 || eventId.length > 128) {
    return { error: "event_id must be 8..128 characters" };
  }
  if (typeof event?.event_type !== "string" || !event.event_type.trim()) {
    return { error: "event_type is required", eventId };
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return { error: "payload object is required", eventId };
  }
  return { eventId, eventType: event.event_type.trim(), payload: event.payload };
}

async function duplicateOneCResponse(db, eventId) {
  const existing = await getProcessed1CEvent(db, eventId);
  if (existing?.status === "processed") {
    return oneCJson({
      status: "success",
      message: "Duplicate ignored",
      event_id: eventId,
      task_id: existing.entity_type === "task" ? existing.entity_id : null,
    });
  }
  if (existing?.status === "failed") {
    return oneCJson({ status: "failed", message: "Event was previously rejected", event_id: eventId }, 409);
  }
  return oneCJson({ status: "processing", message: "Event is already being processed", event_id: eventId }, 202);
}

async function failOneCEvent(env, eventId, message, status = 400) {
  await mark1CEventFailed(env.DB, { eventId, errorMessage: message });
  return oneCJson({ status: "error", message, event_id: eventId }, status);
}

async function handleOneCWebhook(env, request) {
  if (request.method !== "POST") {
    return oneCJson({ status: "error", message: "Method not allowed" }, 405);
  }
  if (!env.ONE_C_WEBHOOK_TOKEN) {
    return oneCJson({ status: "error", message: "Webhook is not configured" }, 503);
  }
  if (request.headers.get("X-1C-Webhook-Token") !== env.ONE_C_WEBHOOK_TOKEN) {
    return oneCJson({ status: "error", message: "Unauthorized" }, 401);
  }

  let event;
  try {
    event = await readOneCEvent(request);
  } catch (error) {
    return oneCJson({ status: "error", message: error.message }, 400);
  }

  const envelope = validateOneCEnvelope(event);
  if (envelope.error) {
    return oneCJson({ status: "error", message: envelope.error, ...(envelope.eventId ? { event_id: envelope.eventId } : {}) }, 400);
  }

  const { eventId, eventType, payload } = envelope;
  if (!(await reserve1CEvent(env.DB, eventId))) {
    return await duplicateOneCResponse(env.DB, eventId);
  }

  try {
    if (eventType !== "task_created") {
      return await failOneCEvent(env, eventId, "Unsupported event_type", 400);
    }

    const projectId = Number.parseInt(event.project_id || "", 10);
    const project = Number.isInteger(projectId) && projectId > 0 ? await getProject(env.DB, projectId) : await getProjectByName(env.DB, event.project_name);
    if (!project) {
      return await failOneCEvent(env, eventId, "Project not found", 400);
    }

    const text = String(payload.text || "").trim();
    if (!text) {
      return await failOneCEvent(env, eventId, "payload.text is required", 400);
    }
    if (payload.priority && !TASK_PRIORITIES.includes(String(payload.priority))) {
      return await failOneCEvent(env, eventId, "Invalid payload.priority", 400);
    }
    if (payload.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.due_date))) {
      return await failOneCEvent(env, eventId, "Invalid payload.due_date", 400);
    }
    if (payload.tags && !Array.isArray(payload.tags)) {
      return await failOneCEvent(env, eventId, "payload.tags must be an array", 400);
    }
    if (Array.isArray(payload.tags) && payload.tags.some((tag) => typeof tag !== "string")) {
      return await failOneCEvent(env, eventId, "payload.tags must contain only strings", 400);
    }

    const integrationUser = await findUserByUsername(env.DB, INTEGRATION_1C_USERNAME);
    if (!integrationUser) {
      return await failOneCEvent(env, eventId, "Integration user is not configured", 500);
    }

    const warnings = [];
    let assigneeId = null;
    if (payload.assignee_username) {
      const assignee = await findUserByUsername(env.DB, payload.assignee_username);
      if (assignee) {
        assigneeId = assignee.id;
      } else {
        warnings.push(`Assignee not found: ${payload.assignee_username}`);
      }
    }

    const task = await createTask(env.DB, {
      projectId: project.id,
      text,
      authorId: integrationUser.id,
      source: "1c_webhook",
      priority: String(payload.priority || "normal"),
      dueDate: String(payload.due_date || ""),
      assigneeId,
    });
    await addEntityTags(env.DB, "task", task.id, ["1с", ...(payload.tags || [])]);
    await auditLog(env.DB, {
      userId: integrationUser.id,
      action: "1c_webhook_task_created",
      entityType: "task",
      entityId: task.id,
      details: { event_id: eventId, event_type: eventType, source: "1c", warnings },
    });
    await changeLog(env.DB, {
      userId: integrationUser.id,
      entityType: "task",
      entityId: task.id,
      fieldName: "1c_webhook",
      oldValue: null,
      newValue: eventType,
      eventType: "1c_webhook_received",
      details: {
        event_id: eventId,
        payload: {
          text: previewValue(text, 160),
          priority: task.priority,
          due_date: task.due_date,
          assignee_username: payload.assignee_username || null,
          tags_count: Array.isArray(payload.tags) ? payload.tags.length : 0,
        },
      },
    });
    await mark1CEventProcessed(env.DB, { eventId, entityType: "task", entityId: task.id });
    return oneCJson({ status: "success", task_id: task.id, event_id: eventId }, 201);
  } catch (error) {
    console.error("1C webhook failed", eventId, error);
    return await failOneCEvent(env, eventId, error.message || "Internal server error", 500);
  }
}

async function handleLogin(request, env) {
  const data = await readRequestData(request);
  if (!(await verifyCsrfToken(request, env, data.csrf_token))) {
    return await renderLogin(env, "Сессия формы устарела. Повторите вход.");
  }

  const ip = clientIp(request);
  if (await isLoginRateLimited(env, ip)) {
    await auditLog(env.DB, {
      action: "login.rate_limited",
      details: { ip, source: "web" },
    });
    return await renderLogin(env, `Слишком много попыток входа. Повторите через ${LOGIN_RATE_LIMIT_WINDOW_MINUTES} минут.`);
  }

  const username = String(data.username || "").trim();
  const password = String(data.password || "");
  const user = await env.DB
    .prepare("SELECT id, username, password_hash, role, telegram_id, display_name, is_active FROM users WHERE username = ?")
    .bind(username)
    .first();

  if (!user || !user.is_active || user.username === INTEGRATION_1C_USERNAME || !(await verifyPassword(password, user.password_hash))) {
    await auditLog(env.DB, {
      action: "login.failure",
      details: { username, ip, source: "web" },
    });
    return await renderLogin(env, "Неверный логин или пароль.");
  }

  await env.DB.prepare("UPDATE users SET last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(user.id).run();
  await auditLog(env.DB, { userId: user.id, action: "login.success", details: { ip, source: "web" } });
  const headers = new Headers();
  appendSetCookie(headers, await createSessionCookie(env, user));
  return redirect("/app", headers);
}

async function handleLogout(request, env, user) {
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  await auditLog(env.DB, { userId: user.id, action: "logout", details: { source: "web" } });
  const headers = new Headers();
  clearSessionCookie(headers);
  return redirect("/login", headers);
}

async function handleDashboard(env, user, ctx) {
  await scheduleBackground(ctx, runTaskDeadlineNotifications(env));
  const riskWindowDays = dueSoonDays(env);
  const projects = await listProjects(env.DB, riskWindowDays, timezoneModifier(env));
  const csrfToken = await createCsrfToken(env);
  const headers = new Headers();
  appendSetCookie(headers, createCsrfCookie(csrfToken));
  return html(renderLayout({ title: "Проекты", content: renderDashboard(projects, user, csrfToken, riskWindowDays), user, csrfToken }), { headers });
}

async function handleProjectPage(env, request, user, projectId, ctx) {
  const project = await getProject(env.DB, projectId);
  if (!project) return renderErrorPage("Проект не найден", 404);
  const url = new URL(request.url);
  const filters = projectFilterParams(url);
  await scheduleBackground(ctx, runTaskDeadlineNotifications(env));
  const riskWindowDays = dueSoonDays(env);
  const today = localDateString(env);
  const dueSoonDate = localDateString(env, riskWindowDays);
  const tzModifier = timezoneModifier(env);
  const [data, searchResults, authors, tags, assignableUsers, changes] = await Promise.all([
    loadProjectData(env.DB, project.id, filters, tzModifier),
    filters.q ? searchProject(env.DB, project.id, filters.q, filters) : Promise.resolve([]),
    listProjectAuthors(env.DB, project.id),
    listProjectTags(env.DB, project.id),
    listAssignableUsers(env.DB),
    listProjectChanges(env.DB, project.id, { entityType: filters.changeEntityType, userId: filters.changeUserId }),
  ]);
  const csrfToken = await createCsrfToken(env);
  const headers = new Headers();
  appendSetCookie(headers, createCsrfCookie(csrfToken));
  return html(renderLayout({ title: project.name, content: renderProject(project, data, searchResults, filters, { authors, tags, assignableUsers, changes, today, dueSoonDate, riskWindowDays }, user, csrfToken), user, csrfToken }), {
    headers,
  });
}

async function handleCreateProject(env, request, user) {
  if (!canManageProjects(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const project = await getOrCreateProject(env.DB, String(data.name || ""), user.id, "web");
  return redirect(projectRedirect(project.id));
}

async function handleCreateTask(env, request, user, ctx) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  const task = await createTask(env.DB, {
    projectId,
    text: String(data.text || ""),
    authorId: user.id,
    source: "web",
    priority: String(data.priority || "normal"),
    dueDate: String(data.due_date || ""),
    assigneeId: data.assignee_id,
  });
  await scheduleBackground(ctx, notifyTaskAssigned(env, task.id, null, task.assignee_id));
  return redirect(projectRedirect(projectId));
}

async function handleTaskStatus(env, request, user, taskId, ctx) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  const result = await updateTaskStatus(env.DB, { taskId, projectId, status: String(data.status || ""), userId: user.id });
  await scheduleBackground(ctx, notifyTaskStatusChanged(env, result.taskId, result.oldStatus, result.newStatus));
  return redirect(projectRedirect(projectId));
}

async function handleTaskEdit(env, request, user, taskId) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  await updateTaskText(env.DB, { taskId, projectId, text: String(data.text || ""), userId: user.id });
  return redirect(projectRedirect(projectId));
}

async function handleTaskMeta(env, request, user, taskId, ctx) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  const result = await updateTaskMeta(env.DB, {
    taskId,
    projectId,
    priority: String(data.priority || "normal"),
    dueDate: String(data.due_date || ""),
    assigneeId: data.assignee_id,
    userId: user.id,
  });
  await scheduleBackground(ctx, notifyTaskAssigned(env, result.taskId, result.oldAssigneeId, result.newAssigneeId));
  return redirect(projectRedirect(projectId));
}

async function handleTaskDelete(env, request, user, taskId) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  await softDeleteTask(env.DB, { taskId, projectId, userId: user.id });
  return redirect(projectRedirect(projectId));
}

async function handleCreateTaskComment(env, request, user, taskId, ctx) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const comment = await createTaskComment(env.DB, {
    taskId,
    authorUserId: user.id,
    body: String(data.body || ""),
    source: "web",
  });
  await scheduleBackground(
    ctx,
    notifyMentionedUsers(env, {
      taskId,
      projectId: comment.project_id,
      projectName: comment.project_name,
      taskText: comment.task_text,
      commentBody: comment.body,
      authorUserId: user.id,
      authorName: user.display_name || user.username,
    }),
  );
  return redirect(projectRedirect(comment.project_id, taskId));
}

async function handleCommentEdit(env, request, user, commentId) {
  const comment = await getTaskComment(env.DB, commentId);
  if (!comment || !canManageComment(user, comment)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const result = await updateTaskComment(env.DB, { commentId, body: String(data.body || ""), userId: user.id });
  return redirect(projectRedirect(result.projectId, result.taskId));
}

async function handleCommentDelete(env, request, user, commentId) {
  const comment = await getTaskComment(env.DB, commentId);
  if (!comment || !canManageComment(user, comment)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const result = await softDeleteTaskComment(env.DB, { commentId, userId: user.id });
  return redirect(projectRedirect(result.projectId, result.taskId));
}

async function handleCreateEntity(env, request, user, config) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  await createTextEntity(env.DB, {
    table: config.table,
    entityType: config.entityType,
    projectId,
    text: String(data.text || ""),
    authorId: user.id,
    source: "web",
  });
  return redirect(projectRedirect(projectId));
}

async function handleEntityEdit(env, request, user, config, entityId) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  await updateTextEntity(env.DB, {
    table: config.table,
    entityType: config.entityType,
    entityId,
    projectId,
    text: String(data.text || ""),
    userId: user.id,
  });
  return redirect(projectRedirect(projectId));
}

async function handleEntityDelete(env, request, user, config, entityId) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  await softDeleteTextEntity(env.DB, { table: config.table, entityType: config.entityType, entityId, projectId, userId: user.id });
  return redirect(projectRedirect(projectId));
}

async function handleCreateLink(env, request, user) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  const url = String(data.url || "");
  if (!isValidUrl(url)) throw new Error("Некорректная ссылка");
  await createLink(env.DB, {
    projectId,
    url,
    description: String(data.description || ""),
    authorId: user.id,
    source: "web",
  });
  return redirect(projectRedirect(projectId));
}

async function handleLinkEdit(env, request, user, linkId) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  const url = String(data.url || "");
  if (!isValidUrl(url)) throw new Error("Некорректная ссылка");
  await updateLink(env.DB, { linkId, projectId, url, description: String(data.description || ""), userId: user.id });
  return redirect(projectRedirect(projectId));
}

async function handleLinkDelete(env, request, user, linkId) {
  if (!canWrite(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const projectId = Number.parseInt(data.project_id, 10);
  await softDeleteLink(env.DB, { linkId, projectId, userId: user.id });
  return redirect(projectRedirect(projectId));
}

async function handleUsersPage(env, request, user) {
  if (!isAdmin(user)) return forbiddenResponse(false);
  const url = new URL(request.url);
  const filters = {
    role: ROLES.includes(url.searchParams.get("role")) ? url.searchParams.get("role") : "",
    active: ["0", "1"].includes(url.searchParams.get("active")) ? url.searchParams.get("active") : "",
  };
  const users = await listUsers(env.DB, filters);
  const csrfToken = await createCsrfToken(env);
  const headers = new Headers();
  appendSetCookie(headers, createCsrfCookie(csrfToken));
  return html(renderLayout({ title: "Пользователи", content: renderUsersPage(users, filters, csrfToken), user, csrfToken }), { headers });
}

async function handleAuditPage(env, request, user) {
  if (!isAdmin(user)) return forbiddenResponse(false);
  const url = new URL(request.url);
  const userId = Number.parseInt(url.searchParams.get("user_id") || "", 10);
  const filters = {
    userId: Number.isInteger(userId) ? userId : "",
    action: cleanFilter(url.searchParams.get("action")),
    entityType: cleanFilter(url.searchParams.get("entity_type")),
  };
  const csrfToken = await createCsrfToken(env);
  const headers = new Headers();
  appendSetCookie(headers, createCsrfCookie(csrfToken));
  return html(renderLayout({ title: "Аудит", content: renderAuditPage(await listAudit(env.DB, filters), filters), user, csrfToken }), { headers });
}

async function handleDeletedPage(env, user) {
  if (!isAdmin(user)) return forbiddenResponse(false);
  const csrfToken = await createCsrfToken(env);
  const headers = new Headers();
  appendSetCookie(headers, createCsrfCookie(csrfToken));
  return html(renderLayout({ title: "Удалённые", content: renderDeletedPage(await listDeletedEntities(env.DB), csrfToken), user, csrfToken }), { headers });
}

async function handleRestoreDeleted(env, request, user, entityType, entityId) {
  if (!isAdmin(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const restored = await restoreEntity(env.DB, { entityType, entityId, userId: user.id });
  return redirect(projectRedirect(restored.project_id));
}

async function handleCreateUser(env, request, user) {
  if (!isAdmin(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const username = String(data.username || "").trim();
  const password = String(data.password || "");
  const role = String(data.role || "viewer");
  if (!username || !password || !ROLES.includes(role)) throw new Error("Некорректные данные пользователя");
  const passwordHash = await hashPassword(password);
  const result = await env.DB
    .prepare(
      "INSERT INTO users (username, password_hash, role, telegram_id, display_name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now')) RETURNING id",
    )
    .bind(username, passwordHash, role, String(data.telegram_id || "").trim() || null, String(data.display_name || "").trim() || null)
    .first();
  await auditLog(env.DB, { userId: user.id, action: "user.created", entityType: "user", entityId: result.id, details: { username, role } });
  return redirect("/app/users");
}

async function handleUserRole(env, request, user, targetId) {
  if (!isAdmin(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const target = await getUser(env.DB, targetId);
  const role = String(data.role || "");
  if (!target || !ROLES.includes(role)) throw new Error("Некорректная роль");
  await env.DB.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(role, targetId).run();
  await auditLog(env.DB, {
    userId: user.id,
    action: "user.role_changed",
    entityType: "user",
    entityId: targetId,
    details: { old_role: target.role, new_role: role },
  });
  return redirect("/app/users");
}

async function handleUserStatus(env, request, user, targetId) {
  if (!isAdmin(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const isActive = String(data.is_active) === "1" ? 1 : 0;
  await env.DB.prepare("UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?").bind(isActive, targetId).run();
  await auditLog(env.DB, {
    userId: user.id,
    action: isActive ? "user.activated" : "user.deactivated",
    entityType: "user",
    entityId: targetId,
  });
  return redirect("/app/users");
}

async function handleUserPassword(env, request, user, targetId) {
  if (!isAdmin(user)) return forbiddenResponse(false);
  const data = await readRequestData(request);
  await requireCsrf(request, env, data);
  const password = String(data.password || "");
  if (password.length < 8) throw new Error("Пароль должен быть не короче 8 символов");
  await env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(await hashPassword(password), targetId).run();
  await auditLog(env.DB, { userId: user.id, action: "user.password_changed", entityType: "user", entityId: targetId });
  return redirect("/app/users");
}

async function handleApi(env, request, url, user, ctx) {
  if (request.method === "GET" && url.pathname === "/api/projects") {
    return json({ projects: await listProjects(env.DB, dueSoonDays(env), timezoneModifier(env)) });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (request.method === "GET" && projectMatch) {
    const projectId = Number.parseInt(projectMatch[1], 10);
    const project = await getProject(env.DB, projectId);
    if (!project) return json({ error: "Project not found" }, { status: 404 });
    return json({ project, data: await loadProjectData(env.DB, projectId, {}, timezoneModifier(env)) });
  }

  if (request.method === "GET" && url.pathname === "/api/search") {
    const projectId = Number.parseInt(url.searchParams.get("project_id") || "", 10);
    if (!projectId) return json({ error: "project_id is required" }, { status: 400 });
    return json({ results: await searchProject(env.DB, projectId, url.searchParams.get("q") || "") });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/users") {
    if (!isAdmin(user)) return forbiddenResponse(true);
    return json({ users: await listUsers(env.DB) });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/audit") {
    if (!isAdmin(user)) return forbiddenResponse(true);
    return json({ audit: await listAudit(env.DB) });
  }

  if (request.method !== "POST") return json({ error: "Not found" }, { status: 404 });
  if (!canWrite(user) && !url.pathname.startsWith("/api/admin/")) return forbiddenResponse(true);

  const data = await readRequestData(request);
  await requireCsrf(request, env, data);

  if (url.pathname === "/api/admin/users") {
    if (!isAdmin(user)) return forbiddenResponse(true);
    const username = String(data.username || "").trim();
    const password = String(data.password || "");
    const role = String(data.role || "viewer");
    if (!username || !password || !ROLES.includes(role)) {
      return json({ error: "Invalid user data" }, { status: 400 });
    }
    const passwordHash = await hashPassword(password);
    const created = await env.DB
      .prepare(
        "INSERT INTO users (username, password_hash, role, telegram_id, display_name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now')) RETURNING id, username, role",
      )
      .bind(username, passwordHash, role, String(data.telegram_id || "").trim() || null, String(data.display_name || "").trim() || null)
      .first();
    await auditLog(env.DB, { userId: user.id, action: "user.created", entityType: "user", entityId: created.id, details: { username, role, source: "api" } });
    return json({ user: created }, { status: 201 });
  }

  const adminUserAction = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/(role|status|password)$/);
  if (adminUserAction) {
    if (!isAdmin(user)) return forbiddenResponse(true);
    const targetId = Number.parseInt(adminUserAction[1], 10);
    if (adminUserAction[2] === "role") {
      const target = await getUser(env.DB, targetId);
      const role = String(data.role || "");
      if (!target || !ROLES.includes(role)) return json({ error: "Invalid role" }, { status: 400 });
      await env.DB.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(role, targetId).run();
      await auditLog(env.DB, {
        userId: user.id,
        action: "user.role_changed",
        entityType: "user",
        entityId: targetId,
        details: { old_role: target.role, new_role: role, source: "api" },
      });
      return json({ ok: true });
    }
    if (adminUserAction[2] === "status") {
      const isActive = String(data.is_active) === "1" ? 1 : 0;
      await env.DB.prepare("UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?").bind(isActive, targetId).run();
      await auditLog(env.DB, {
        userId: user.id,
        action: isActive ? "user.activated" : "user.deactivated",
        entityType: "user",
        entityId: targetId,
        details: { source: "api" },
      });
      return json({ ok: true });
    }
    const password = String(data.password || "");
    if (password.length < 8) return json({ error: "Password is too short" }, { status: 400 });
    await env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(await hashPassword(password), targetId).run();
    await auditLog(env.DB, {
      userId: user.id,
      action: "user.password_changed",
      entityType: "user",
      entityId: targetId,
      details: { source: "api" },
    });
    return json({ ok: true });
  }

  if (url.pathname === "/api/projects") {
    if (!canManageProjects(user)) return forbiddenResponse(true);
    const project = await getOrCreateProject(env.DB, String(data.name || ""), user.id, "api");
    return json({ project }, { status: 201 });
  }

  if (url.pathname === "/api/tasks") {
    const task = await createTask(env.DB, {
      projectId: Number.parseInt(data.project_id, 10),
      text: String(data.text || ""),
      authorId: user.id,
      source: "api",
      priority: String(data.priority || "normal"),
      dueDate: String(data.due_date || ""),
      assigneeId: data.assignee_id,
    });
    await scheduleBackground(ctx, notifyTaskAssigned(env, task.id, null, task.assignee_id));
    return json({ task }, { status: 201 });
  }

  const taskAction = url.pathname.match(/^\/api\/tasks\/(\d+)\/(status|meta|edit|delete)$/);
  if (taskAction) {
    const taskId = Number.parseInt(taskAction[1], 10);
    const projectId = Number.parseInt(data.project_id, 10);
    if (taskAction[2] === "status") {
      const result = await updateTaskStatus(env.DB, { taskId, projectId, status: String(data.status || ""), userId: user.id });
      await scheduleBackground(ctx, notifyTaskStatusChanged(env, result.taskId, result.oldStatus, result.newStatus));
    }
    if (taskAction[2] === "meta") {
      const result = await updateTaskMeta(env.DB, {
        taskId,
        projectId,
        priority: String(data.priority || "normal"),
        dueDate: String(data.due_date || ""),
        assigneeId: data.assignee_id,
        userId: user.id,
      });
      await scheduleBackground(ctx, notifyTaskAssigned(env, result.taskId, result.oldAssigneeId, result.newAssigneeId));
    }
    if (taskAction[2] === "edit") await updateTaskText(env.DB, { taskId, projectId, text: String(data.text || ""), userId: user.id });
    if (taskAction[2] === "delete") await softDeleteTask(env.DB, { taskId, projectId, userId: user.id });
    return json({ ok: true });
  }

  for (const [path, config] of Object.entries(ENTITY_PATHS)) {
    if (url.pathname === `/api/${path}`) {
      const entity = await createTextEntity(env.DB, {
        table: config.table,
        entityType: config.entityType,
        projectId: Number.parseInt(data.project_id, 10),
        text: String(data.text || ""),
        authorId: user.id,
        source: "api",
      });
      return json({ entity }, { status: 201 });
    }

    const match = url.pathname.match(new RegExp(`^/api/${path}/(\\d+)/(edit|delete)$`));
    if (match) {
      const entityId = Number.parseInt(match[1], 10);
      const projectId = Number.parseInt(data.project_id, 10);
      if (match[2] === "edit") {
        await updateTextEntity(env.DB, {
          table: config.table,
          entityType: config.entityType,
          entityId,
          projectId,
          text: String(data.text || ""),
          userId: user.id,
        });
      } else {
        await softDeleteTextEntity(env.DB, { table: config.table, entityType: config.entityType, entityId, projectId, userId: user.id });
      }
      return json({ ok: true });
    }
  }

  if (url.pathname === "/api/links") {
    if (!isValidUrl(String(data.url || ""))) return json({ error: "Invalid URL" }, { status: 400 });
    const link = await createLink(env.DB, {
      projectId: Number.parseInt(data.project_id, 10),
      url: String(data.url || ""),
      description: String(data.description || ""),
      authorId: user.id,
      source: "api",
    });
    return json({ link }, { status: 201 });
  }

  const linkAction = url.pathname.match(/^\/api\/links\/(\d+)\/(edit|delete)$/);
  if (linkAction) {
    const linkId = Number.parseInt(linkAction[1], 10);
    const projectId = Number.parseInt(data.project_id, 10);
    if (linkAction[2] === "edit") {
      if (!isValidUrl(String(data.url || ""))) return json({ error: "Invalid URL" }, { status: 400 });
      await updateLink(env.DB, { linkId, projectId, url: String(data.url || ""), description: String(data.description || ""), userId: user.id });
    } else {
      await softDeleteLink(env.DB, { linkId, projectId, userId: user.id });
    }
    return json({ ok: true });
  }

  return json({ error: "Not found" }, { status: 404 });
}

export async function handleWebRequest(request, env, ctx = null) {
  const url = new URL(request.url);

  try {
    if (url.pathname === "/api/webhooks/1c-events") {
      return await handleOneCWebhook(env, request);
    }

    if (request.method === "GET" && url.pathname === "/login") {
      const user = await getCurrentUser(request, env);
      return user ? redirect("/app") : await renderLogin(env);
    }

    if (request.method === "POST" && url.pathname === "/login") {
      return await handleLogin(request, env);
    }

    const user = await getCurrentUser(request, env);
    const wantsApi = url.pathname.startsWith("/api/");
    if (!user) {
      return wantsApi ? json({ error: "Unauthorized" }, { status: 401 }) : redirect("/login");
    }

    if (request.method === "POST" && url.pathname === "/logout") return await handleLogout(request, env, user);
    if (url.pathname.startsWith("/api/")) return await handleApi(env, request, url, user, ctx);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/projects")) {
      return await handleDashboard(env, user, ctx);
    }

    const exportMatch = url.pathname.match(/^\/app\/projects\/(\d+)\/export\.(json|csv|md)$/);
    if (request.method === "GET" && exportMatch) {
      return await handleProjectExport(env, user, Number.parseInt(exportMatch[1], 10), exportMatch[2]);
    }

    const projectMatch = url.pathname.match(/^\/app\/projects\/(\d+)$/);
    if (request.method === "GET" && projectMatch) {
      return await handleProjectPage(env, request, user, Number.parseInt(projectMatch[1], 10), ctx);
    }

    if (request.method === "GET" && url.pathname === "/app/users") return await handleUsersPage(env, request, user);
    if (request.method === "GET" && url.pathname === "/app/deleted") return await handleDeletedPage(env, user);
    if (request.method === "GET" && url.pathname === "/app/audit") return await handleAuditPage(env, request, user);

    if (request.method === "POST" && url.pathname === "/app/projects") return await handleCreateProject(env, request, user);
    if (request.method === "POST" && url.pathname === "/app/tasks") return await handleCreateTask(env, request, user, ctx);

    const taskAction = url.pathname.match(/^\/app\/tasks\/(\d+)\/(status|meta|edit|delete)$/);
    if (request.method === "POST" && taskAction) {
      const taskId = Number.parseInt(taskAction[1], 10);
      if (taskAction[2] === "status") return await handleTaskStatus(env, request, user, taskId, ctx);
      if (taskAction[2] === "meta") return await handleTaskMeta(env, request, user, taskId, ctx);
      if (taskAction[2] === "edit") return await handleTaskEdit(env, request, user, taskId);
      return await handleTaskDelete(env, request, user, taskId);
    }

    const taskCommentAction = url.pathname.match(/^\/app\/tasks\/(\d+)\/comments$/);
    if (request.method === "POST" && taskCommentAction) {
      return await handleCreateTaskComment(env, request, user, Number.parseInt(taskCommentAction[1], 10), ctx);
    }

    const commentAction = url.pathname.match(/^\/app\/comments\/(\d+)\/(edit|delete)$/);
    if (request.method === "POST" && commentAction) {
      const commentId = Number.parseInt(commentAction[1], 10);
      if (commentAction[2] === "edit") return await handleCommentEdit(env, request, user, commentId);
      return await handleCommentDelete(env, request, user, commentId);
    }

    for (const [path, config] of Object.entries(ENTITY_PATHS)) {
      if (request.method === "POST" && url.pathname === `/app/${path}`) return await handleCreateEntity(env, request, user, config);
      const match = url.pathname.match(new RegExp(`^/app/${path}/(\\d+)/(edit|delete)$`));
      if (request.method === "POST" && match) {
        const entityId = Number.parseInt(match[1], 10);
        if (match[2] === "edit") return await handleEntityEdit(env, request, user, config, entityId);
        return await handleEntityDelete(env, request, user, config, entityId);
      }
    }

    if (request.method === "POST" && url.pathname === "/app/links") return await handleCreateLink(env, request, user);
    const linkAction = url.pathname.match(/^\/app\/links\/(\d+)\/(edit|delete)$/);
    if (request.method === "POST" && linkAction) {
      const linkId = Number.parseInt(linkAction[1], 10);
      if (linkAction[2] === "edit") return await handleLinkEdit(env, request, user, linkId);
      return await handleLinkDelete(env, request, user, linkId);
    }

    const userAction = url.pathname.match(/^\/app\/users\/(\d+)\/(role|status|password)$/);
    const restoreAction = url.pathname.match(/^\/app\/deleted\/([a-z]+)\/(\d+)\/restore$/);
    if (request.method === "POST" && url.pathname === "/app/users") return await handleCreateUser(env, request, user);
    if (request.method === "POST" && userAction) {
      const targetId = Number.parseInt(userAction[1], 10);
      if (userAction[2] === "role") return await handleUserRole(env, request, user, targetId);
      if (userAction[2] === "status") return await handleUserStatus(env, request, user, targetId);
      return await handleUserPassword(env, request, user, targetId);
    }
    if (request.method === "POST" && restoreAction) {
      return await handleRestoreDeleted(env, request, user, restoreAction[1], Number.parseInt(restoreAction[2], 10));
    }

    return renderErrorPage("Страница не найдена", 404);
  } catch (error) {
    console.error("Web panel error", error);
    if (url.pathname.startsWith("/api/")) {
      return json({ error: error.message || "Internal server error" }, { status: 500 });
    }
    return renderErrorPage(error.message || "Не удалось выполнить действие", 500);
  }
}
