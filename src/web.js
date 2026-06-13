import { TASK_STATUSES, extractHashtags, isTaskStatus, isValidUrl } from "./utils.js";

const ENTITY_CONFIG = {
  ideas: { table: "ideas", entityType: "idea", label: "Идеи", single: "Идея" },
  notes: { table: "notes", entityType: "note", label: "Заметки", single: "Заметка" },
  decisions: { table: "decisions", entityType: "decision", label: "Решения", single: "Решение" },
};

const STATUS_LABELS = {
  todo: "todo",
  doing: "doing",
  review: "review",
  done: "done",
};

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

function redirect(location, status = 303) {
  return new Response(null, { status, headers: { location } });
}

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Project dashboard", charset="UTF-8"' },
  });
}

function forbidden(message) {
  return html(renderLayout({ title: "Ошибка", content: `<section class="panel"><h1>Ошибка</h1><p>${escapeHtml(message)}</p></section>` }), {
    status: 400,
  });
}

function decodeBasicCredentials(header) {
  if (!header || !header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return null;
    }
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function isAuthorized(request, env) {
  const username = env.PANEL_USERNAME;
  const password = env.PANEL_PASSWORD;
  if (!username || !password) {
    return false;
  }

  const credentials = decodeBasicCredentials(request.headers.get("authorization"));
  return credentials?.username === username && credentials?.password === password;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  return value.replace("T", " ").replace(/\.\d+Z$/, "");
}

function currentPath(url) {
  return `${url.pathname}${url.search}`;
}

function renderLayout({ title, content }) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Project Panel</title>
  <style>
    :root {
      color-scheme: light;
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
      min-width: 320px;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.45;
    }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 248px 1fr;
    }

    .sidebar {
      background: #111827;
      color: #f9fafb;
      padding: 22px 18px;
    }

    .brand {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 22px;
    }

    .nav {
      display: grid;
      gap: 6px;
    }

    .nav a {
      color: #d1d5db;
      padding: 9px 10px;
      border-radius: 8px;
    }

    .nav a:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
      text-decoration: none;
    }

    .main {
      padding: 28px;
      overflow: auto;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
    }

    h1, h2, h3 {
      margin: 0;
      line-height: 1.2;
      letter-spacing: 0;
    }

    h1 { font-size: 26px; }
    h2 { font-size: 18px; margin-bottom: 14px; }
    h3 { font-size: 15px; margin-bottom: 10px; }

    .muted { color: var(--muted); }

    .grid {
      display: grid;
      gap: 16px;
    }

    .grid.two {
      grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
      align-items: start;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }

    .stat, .panel, .card, .task {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .stat { padding: 14px; }
    .stat strong { display: block; font-size: 24px; }
    .stat span { color: var(--muted); }

    .panel { padding: 18px; }

    .project-list {
      display: grid;
      gap: 10px;
    }

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

    .columns {
      display: grid;
      grid-template-columns: repeat(4, minmax(180px, 1fr));
      gap: 12px;
    }

    .column {
      min-width: 0;
      background: var(--surface-soft);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }

    .task {
      padding: 12px;
      margin-bottom: 10px;
    }

    .task-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 10px;
    }

    .items {
      display: grid;
      gap: 10px;
    }

    .card {
      padding: 12px;
      overflow-wrap: anywhere;
    }

    .forms {
      display: grid;
      gap: 14px;
    }

    form.compact {
      display: grid;
      gap: 8px;
    }

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

    textarea {
      min-height: 84px;
      resize: vertical;
    }

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

    button:hover, .button:hover {
      background: var(--accent-dark);
      text-decoration: none;
    }

    .button.secondary, button.secondary {
      background: #ffffff;
      border-color: var(--border);
      color: var(--text);
    }

    .inline-form {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .inline-form select { min-width: 105px; }

    .search {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }

    .section-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    @media (max-width: 1100px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { position: static; }
      .grid.two, .section-grid, .columns, .stats { grid-template-columns: 1fr; }
      .main { padding: 18px; }
      .topbar { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">Project Panel</div>
      <nav class="nav" aria-label="Основная навигация">
        <a href="/app">Проекты</a>
        <a href="/app#tasks">Задачи</a>
        <a href="/app#ideas">Идеи</a>
        <a href="/app#notes">Заметки</a>
        <a href="/app#decisions">Решения</a>
        <a href="/app#links">Ссылки</a>
        <a href="/app#search">Поиск</a>
      </nav>
    </aside>
    <main class="main">${content}</main>
  </div>
</body>
</html>`;
}

async function saveTags(db, entityType, entityId, text) {
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

async function createTextEntity(db, table, entityType, projectId, text) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Текст не может быть пустым");
  }
  const row = await db
    .prepare(`INSERT INTO ${table} (project_id, text, created_at) VALUES (?, ?, datetime('now')) RETURNING *`)
    .bind(projectId, cleanText)
    .first();
  await saveTags(db, entityType, row.id, cleanText);
  return row;
}

async function listProjects(db) {
  const { results } = await db
    .prepare(
      `SELECT
        p.id,
        p.name,
        p.created_at,
        SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo_count,
        SUM(CASE WHEN t.status = 'doing' THEN 1 ELSE 0 END) AS doing_count,
        SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) AS review_count,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_count,
        (SELECT COUNT(*) FROM ideas WHERE project_id = p.id) AS ideas_count,
        (SELECT COUNT(*) FROM notes WHERE project_id = p.id) AS notes_count,
        (SELECT COUNT(*) FROM decisions WHERE project_id = p.id) AS decisions_count,
        (SELECT COUNT(*) FROM links WHERE project_id = p.id) AS links_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id
      ORDER BY p.name`,
    )
    .all();
  return results;
}

async function getProject(db, projectId) {
  return await db.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
}

async function createProject(db, name) {
  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error("Название проекта не может быть пустым");
  }
  const existing = await db.prepare("SELECT * FROM projects WHERE name = ?").bind(cleanName).first();
  if (existing) {
    return existing;
  }
  return await db
    .prepare("INSERT INTO projects (name, created_at) VALUES (?, datetime('now')) RETURNING *")
    .bind(cleanName)
    .first();
}

async function loadProjectData(db, projectId) {
  const [tasks, ideas, notes, decisions, links] = await Promise.all([
    db.prepare("SELECT id, text, status, created_at FROM tasks WHERE project_id = ? ORDER BY created_at DESC").bind(projectId).all(),
    db.prepare("SELECT id, text, created_at FROM ideas WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").bind(projectId).all(),
    db.prepare("SELECT id, text, created_at FROM notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").bind(projectId).all(),
    db.prepare("SELECT id, text, created_at FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").bind(projectId).all(),
    db
      .prepare("SELECT id, url, description, created_at FROM links WHERE project_id = ? ORDER BY created_at DESC LIMIT 100")
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

async function searchProject(db, projectId, query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return [];
  }

  const like = `%${cleanQuery}%`;
  const [ideas, tasks, links, notes, decisions] = await Promise.all([
    db.prepare("SELECT id, text FROM ideas WHERE project_id = ? AND text LIKE ? LIMIT 10").bind(projectId, like).all(),
    db.prepare("SELECT id, text FROM tasks WHERE project_id = ? AND text LIKE ? LIMIT 10").bind(projectId, like).all(),
    db
      .prepare(
        "SELECT id, COALESCE(url, '') || ' ' || COALESCE(description, '') AS text FROM links WHERE project_id = ? AND (COALESCE(url, '') || ' ' || COALESCE(description, '')) LIKE ? LIMIT 10",
      )
      .bind(projectId, like)
      .all(),
    db.prepare("SELECT id, text FROM notes WHERE project_id = ? AND text LIKE ? LIMIT 10").bind(projectId, like).all(),
    db.prepare("SELECT id, text FROM decisions WHERE project_id = ? AND text LIKE ? LIMIT 10").bind(projectId, like).all(),
  ]);

  return [
    ...ideas.results.map((row) => ({ kind: "Идея", ...row })),
    ...tasks.results.map((row) => ({ kind: "Задача", ...row })),
    ...links.results.map((row) => ({ kind: "Ссылка", ...row })),
    ...notes.results.map((row) => ({ kind: "Заметка", ...row })),
    ...decisions.results.map((row) => ({ kind: "Решение", ...row })),
  ];
}

function renderDashboard(projects) {
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
      return acc;
    },
    { todo: 0, doing: 0, review: 0, done: 0, ideas: 0, notes: 0, decisions: 0, links: 0 },
  );

  const projectRows = projects.length
    ? projects
        .map(
          (project) => `<article class="project-row">
            <div>
              <h3>${escapeHtml(project.name)}</h3>
              <p class="muted">Задачи: todo ${Number(project.todo_count || 0)}, doing ${Number(project.doing_count || 0)}, review ${Number(project.review_count || 0)}, done ${Number(project.done_count || 0)}</p>
              <p class="muted">Идеи ${Number(project.ideas_count || 0)} · Заметки ${Number(project.notes_count || 0)} · Решения ${Number(project.decisions_count || 0)} · Ссылки ${Number(project.links_count || 0)}</p>
            </div>
            <a class="button" href="/app/projects/${project.id}">Открыть</a>
          </article>`,
        )
        .join("")
    : `<p class="muted">Проектов пока нет.</p>`;

  return renderLayout({
    title: "Проекты",
    content: `<div class="topbar">
      <div>
        <h1>Проекты</h1>
        <p class="muted">Рабочая панель проектной базы.</p>
      </div>
    </div>

    <section class="stats" aria-label="Статистика">
      <div class="stat"><strong>${totals.todo}</strong><span>todo</span></div>
      <div class="stat"><strong>${totals.doing}</strong><span>doing</span></div>
      <div class="stat"><strong>${totals.review}</strong><span>review</span></div>
      <div class="stat"><strong>${totals.done}</strong><span>done</span></div>
      <div class="stat"><strong>${totals.ideas}</strong><span>идей</span></div>
      <div class="stat"><strong>${totals.notes}</strong><span>заметок</span></div>
      <div class="stat"><strong>${totals.decisions}</strong><span>решений</span></div>
      <div class="stat"><strong>${totals.links}</strong><span>ссылок</span></div>
    </section>

    <div class="grid two">
      <section class="panel">
        <h2>Список проектов</h2>
        <div class="project-list">${projectRows}</div>
      </section>
      <section class="panel">
        <h2>Создать проект</h2>
        <form class="compact" method="post" action="/app/projects">
          <input name="name" placeholder="Название проекта" required>
          <button type="submit">Создать</button>
        </form>
      </section>
    </div>`,
  });
}

function renderTask(task, projectId) {
  const options = TASK_STATUSES.map(
    (status) => `<option value="${status}" ${task.status === status ? "selected" : ""}>${STATUS_LABELS[status]}</option>`,
  ).join("");
  return `<article class="task">
    <div>#${task.id} ${escapeHtml(task.text)}</div>
    <div class="task-footer">
      <span class="muted">${escapeHtml(formatDate(task.created_at))}</span>
      <form class="inline-form" method="post" action="/app/tasks/${task.id}/status">
        <input type="hidden" name="project_id" value="${projectId}">
        <select name="status">${options}</select>
        <button class="secondary" type="submit">OK</button>
      </form>
    </div>
  </article>`;
}

function renderTextCards(items) {
  return items.length
    ? items
        .map(
          (item) => `<article class="card">
            <div>#${item.id} ${escapeHtml(item.text)}</div>
            <div class="muted">${escapeHtml(formatDate(item.created_at))}</div>
          </article>`,
        )
        .join("")
    : `<p class="muted">Нет записей.</p>`;
}

function renderLinks(items) {
  return items.length
    ? items
        .map(
          (item) => `<article class="card">
            <div><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a></div>
            <div>${escapeHtml(item.description || "")}</div>
            <div class="muted">#${item.id} · ${escapeHtml(formatDate(item.created_at))}</div>
          </article>`,
        )
        .join("")
    : `<p class="muted">Нет ссылок.</p>`;
}

function renderSearchResults(results, query) {
  if (!query) {
    return "";
  }

  if (!results.length) {
    return `<div class="card">Ничего не найдено.</div>`;
  }

  return `<div class="items">${results
    .map((item) => `<article class="card"><strong>${escapeHtml(item.kind)} #${item.id}</strong><div>${escapeHtml(item.text)}</div></article>`)
    .join("")}</div>`;
}

function renderCreateForms(projectId) {
  return `<section class="panel">
    <h2>Добавить запись</h2>
    <div class="forms">
      <form class="compact" method="post" action="/app/tasks">
        <input type="hidden" name="project_id" value="${projectId}">
        <textarea name="text" placeholder="Новая задача" required></textarea>
        <button type="submit">Создать задачу</button>
      </form>
      <form class="compact" method="post" action="/app/ideas">
        <input type="hidden" name="project_id" value="${projectId}">
        <textarea name="text" placeholder="Новая идея" required></textarea>
        <button type="submit">Сохранить идею</button>
      </form>
      <form class="compact" method="post" action="/app/notes">
        <input type="hidden" name="project_id" value="${projectId}">
        <textarea name="text" placeholder="Новая заметка" required></textarea>
        <button type="submit">Сохранить заметку</button>
      </form>
      <form class="compact" method="post" action="/app/decisions">
        <input type="hidden" name="project_id" value="${projectId}">
        <textarea name="text" placeholder="Новое решение" required></textarea>
        <button type="submit">Зафиксировать решение</button>
      </form>
      <form class="compact" method="post" action="/app/links">
        <input type="hidden" name="project_id" value="${projectId}">
        <input name="url" placeholder="https://example.com" required>
        <input name="description" placeholder="Описание ссылки">
        <button type="submit">Сохранить ссылку</button>
      </form>
    </div>
  </section>`;
}

function renderProject(project, data, searchResults, query) {
  const taskColumns = TASK_STATUSES.map((status) => {
    const tasks = data.tasks.filter((task) => task.status === status);
    return `<section class="column">
      <h3>${STATUS_LABELS[status]}</h3>
      ${tasks.length ? tasks.map((task) => renderTask(task, project.id)).join("") : `<p class="muted">Нет задач.</p>`}
    </section>`;
  }).join("");

  return renderLayout({
    title: project.name,
    content: `<div class="topbar">
      <div>
        <h1>${escapeHtml(project.name)}</h1>
        <p class="muted">Создан: ${escapeHtml(formatDate(project.created_at))}</p>
      </div>
      <a class="button secondary" href="/app">Все проекты</a>
    </div>

    <section class="panel" id="search">
      <h2>Поиск</h2>
      <form class="search" method="get" action="/app/projects/${project.id}">
        <input name="q" value="${escapeHtml(query)}" placeholder="Искать по проекту">
        <button type="submit">Найти</button>
      </form>
      ${renderSearchResults(searchResults, query)}
    </section>

    <div class="grid two" style="margin-top:16px">
      <div class="grid">
        <section class="panel" id="tasks">
          <h2>Задачи</h2>
          <div class="columns">${taskColumns}</div>
        </section>

        <div class="section-grid">
          <section class="panel" id="ideas"><h2>Идеи</h2><div class="items">${renderTextCards(data.ideas)}</div></section>
          <section class="panel" id="notes"><h2>Заметки</h2><div class="items">${renderTextCards(data.notes)}</div></section>
          <section class="panel" id="decisions"><h2>Решения</h2><div class="items">${renderTextCards(data.decisions)}</div></section>
          <section class="panel" id="links"><h2>Ссылки</h2><div class="items">${renderLinks(data.links)}</div></section>
        </div>
      </div>
      ${renderCreateForms(project.id)}
    </div>`,
  });
}

async function readForm(request) {
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

function projectRedirect(projectId) {
  return `/app/projects/${encodeURIComponent(projectId)}`;
}

async function handleDashboard(env) {
  const projects = await listProjects(env.DB);
  return html(renderDashboard(projects));
}

async function handleProjectPage(env, request, projectId) {
  const project = await getProject(env.DB, projectId);
  if (!project) {
    return html(renderLayout({ title: "Проект не найден", content: `<section class="panel"><h1>Проект не найден</h1></section>` }), {
      status: 404,
    });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";
  const [data, searchResults] = await Promise.all([
    loadProjectData(env.DB, project.id),
    query ? searchProject(env.DB, project.id, query) : Promise.resolve([]),
  ]);
  return html(renderProject(project, data, searchResults, query));
}

async function handleCreateProject(env, request) {
  const form = await readForm(request);
  const project = await createProject(env.DB, String(form.name || ""));
  return redirect(projectRedirect(project.id));
}

async function handleCreateTask(env, request) {
  const form = await readForm(request);
  const projectId = Number.parseInt(form.project_id, 10);
  const text = String(form.text || "").trim();
  if (!projectId || !text) {
    return forbidden("Укажите проект и текст задачи.");
  }
  const task = await env.DB
    .prepare("INSERT INTO tasks (project_id, text, status, created_at) VALUES (?, ?, 'todo', datetime('now')) RETURNING *")
    .bind(projectId, text)
    .first();
  await saveTags(env.DB, "task", task.id, text);
  return redirect(projectRedirect(projectId));
}

async function handleTaskStatus(env, request, taskId) {
  const form = await readForm(request);
  const projectId = Number.parseInt(form.project_id, 10);
  const status = String(form.status || "");
  if (!projectId || !isTaskStatus(status)) {
    return forbidden("Некорректный статус задачи.");
  }

  await env.DB.prepare("UPDATE tasks SET status = ? WHERE id = ? AND project_id = ?").bind(status, taskId, projectId).run();
  return redirect(projectRedirect(projectId));
}

async function handleCreateTextEntity(env, request, config) {
  const form = await readForm(request);
  const projectId = Number.parseInt(form.project_id, 10);
  const text = String(form.text || "");
  if (!projectId || !text.trim()) {
    return forbidden("Укажите проект и текст.");
  }
  await createTextEntity(env.DB, config.table, config.entityType, projectId, text);
  return redirect(projectRedirect(projectId));
}

async function handleCreateLink(env, request) {
  const form = await readForm(request);
  const projectId = Number.parseInt(form.project_id, 10);
  const url = String(form.url || "").trim();
  const description = String(form.description || "").trim();
  if (!projectId || !isValidUrl(url)) {
    return forbidden("Некорректная ссылка. Нужен URL с http или https.");
  }

  const link = await env.DB
    .prepare("INSERT INTO links (project_id, url, description, created_at) VALUES (?, ?, ?, datetime('now')) RETURNING *")
    .bind(projectId, url, description || null)
    .first();
  await saveTags(env.DB, "link", link.id, `${url} ${description}`);
  return redirect(projectRedirect(projectId));
}

async function handleApi(env, request, url) {
  if (request.method === "GET" && url.pathname === "/api/projects") {
    return json({ projects: await listProjects(env.DB) });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (request.method === "GET" && projectMatch) {
    const projectId = Number.parseInt(projectMatch[1], 10);
    const project = await getProject(env.DB, projectId);
    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }
    return json({ project, data: await loadProjectData(env.DB, projectId) });
  }

  if (request.method === "GET" && url.pathname === "/api/search") {
    const projectId = Number.parseInt(url.searchParams.get("project_id") || "", 10);
    const query = url.searchParams.get("q") || "";
    if (!projectId) {
      return json({ error: "project_id is required" }, { status: 400 });
    }
    return json({ results: await searchProject(env.DB, projectId, query) });
  }

  return json({ error: "Not found" }, { status: 404 });
}

export async function handleWebRequest(request, env) {
  if (!isAuthorized(request, env)) {
    return unauthorized();
  }

  const url = new URL(request.url);

  try {
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(env, request, url);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/projects")) {
      return await handleDashboard(env);
    }

    const projectMatch = url.pathname.match(/^\/app\/projects\/(\d+)$/);
    if (request.method === "GET" && projectMatch) {
      return await handleProjectPage(env, request, Number.parseInt(projectMatch[1], 10));
    }

    if (request.method === "POST" && url.pathname === "/app/projects") {
      return await handleCreateProject(env, request);
    }

    if (request.method === "POST" && url.pathname === "/app/tasks") {
      return await handleCreateTask(env, request);
    }

    const taskStatusMatch = url.pathname.match(/^\/app\/tasks\/(\d+)\/status$/);
    if (request.method === "POST" && taskStatusMatch) {
      return await handleTaskStatus(env, request, Number.parseInt(taskStatusMatch[1], 10));
    }

    for (const [path, config] of Object.entries(ENTITY_CONFIG)) {
      if (request.method === "POST" && url.pathname === `/app/${path}`) {
        return await handleCreateTextEntity(env, request, config);
      }
    }

    if (request.method === "POST" && url.pathname === "/app/links") {
      return await handleCreateLink(env, request);
    }

    return html(renderLayout({ title: "Не найдено", content: `<section class="panel"><h1>Страница не найдена</h1></section>` }), {
      status: 404,
    });
  } catch (error) {
    console.error("Web panel error", error);
    const wantsJson = url.pathname.startsWith("/api/");
    if (wantsJson) {
      return json({ error: "Internal server error" }, { status: 500 });
    }
    return html(
      renderLayout({
        title: "Ошибка",
        content: `<section class="panel"><h1>Ошибка</h1><p>Не удалось выполнить действие. Проверьте данные и повторите.</p><p class="muted">${escapeHtml(error.message)}</p></section>`,
      }),
      { status: 500 },
    );
  }
}
