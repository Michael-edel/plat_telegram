const SESSION_COOKIE = "pp_session";
const CSRF_COOKIE = "pp_csrf";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PASSWORD_ITERATIONS = 100000;

export const ROLES = ["admin", "manager", "editor", "viewer"];
export const WRITE_ROLES = ["admin", "manager", "editor"];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64UrlEncode(bytes) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  const left = textEncoder.encode(a);
  const right = textEncoder.encode(b);
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function signValue(secret, value) {
  return `${value}.${await hmac(secret, value)}`;
}

async function verifySignedValue(secret, signedValue) {
  if (!signedValue) {
    return null;
  }

  const separator = signedValue.lastIndexOf(".");
  if (separator === -1) {
    return null;
  }

  const value = signedValue.slice(0, separator);
  const signature = signedValue.slice(separator + 1);
  const expected = await hmac(secret, value);
  return timingSafeEqual(signature, expected) ? value : null;
}

function getSecret(env) {
  return env.SESSION_SECRET || env.WEBHOOK_SECRET || env.PANEL_PASSWORD;
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return "";
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

export function appendSetCookie(headers, cookie) {
  headers.append("set-cookie", cookie);
}

export function clearSessionCookie(headers) {
  appendSetCookie(headers, serializeCookie(SESSION_COOKIE, "", { maxAge: 0 }));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PASSWORD_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return `pbkdf2:sha256:${PASSWORD_ITERATIONS}:${base64UrlEncode(salt)}:${base64UrlEncode(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, storedHash) {
  const [kind, hashName, iterationsValue, saltValue, hashValue] = String(storedHash || "").split(":");
  if (kind !== "pbkdf2" || hashName !== "sha256" || !iterationsValue || !saltValue || !hashValue) {
    return false;
  }

  const iterations = Number.parseInt(iterationsValue, 10);
  if (!Number.isInteger(iterations) || iterations < 100000) {
    return false;
  }

  const salt = base64UrlDecode(saltValue);
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return timingSafeEqual(base64UrlEncode(new Uint8Array(bits)), hashValue);
}

export async function createSessionCookie(env, user) {
  const secret = getSecret(env);
  if (!secret) {
    throw new Error("SESSION_SECRET is required for web sessions");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    user_id: user.id,
    role: user.role,
    username: user.username,
    issued_at: now,
    expires_at: now + SESSION_TTL_SECONDS,
  };
  const encoded = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  return serializeCookie(SESSION_COOKIE, await signValue(secret, encoded), { maxAge: SESSION_TTL_SECONDS });
}

export async function readSession(request, env) {
  const secret = getSecret(env);
  if (!secret) {
    return null;
  }

  const encoded = await verifySignedValue(secret, getCookie(request, SESSION_COOKIE));
  if (!encoded) {
    return null;
  }

  try {
    const payload = JSON.parse(textDecoder.decode(base64UrlDecode(encoded)));
    if (!payload.expires_at || payload.expires_at < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function createCsrfToken(env) {
  const secret = getSecret(env);
  if (!secret) {
    throw new Error("SESSION_SECRET is required for CSRF protection");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(24))),
    expires_at: now + SESSION_TTL_SECONDS,
  };
  return await signValue(secret, base64UrlEncode(textEncoder.encode(JSON.stringify(payload))));
}

export function createCsrfCookie(token) {
  return serializeCookie(CSRF_COOKIE, token, { maxAge: SESSION_TTL_SECONDS });
}

export async function verifyCsrfToken(request, env, formToken) {
  if (!formToken) {
    return false;
  }
  const encoded = await verifySignedValue(getSecret(env), formToken);
  if (!encoded) {
    return false;
  }

  try {
    const payload = JSON.parse(textDecoder.decode(base64UrlDecode(encoded)));
    return Boolean(payload.expires_at && payload.expires_at >= Math.floor(Date.now() / 1000));
  } catch {
    return true;
  }
}

export function requireRole(user, allowedRoles) {
  return Boolean(user && user.is_active && allowedRoles.includes(user.role));
}

export async function ensureInitialAdmin(db, env) {
  const countRow = await db.prepare("SELECT COUNT(*) AS count FROM users").first();
  if (Number(countRow?.count || 0) > 0) {
    return;
  }

  const username = env.INITIAL_ADMIN_USERNAME || env.PANEL_USERNAME;
  const password = env.INITIAL_ADMIN_PASSWORD || env.PANEL_PASSWORD;
  if (!username || !password) {
    return;
  }

  const passwordHash = await hashPassword(password);
  await db
    .prepare(
      "INSERT INTO users (username, password_hash, role, display_name, is_active, created_at, updated_at) VALUES (?, ?, 'admin', ?, 1, datetime('now'), datetime('now'))",
    )
    .bind(username, passwordHash, "Администратор")
    .run();
}

export async function getCurrentUser(request, env) {
  await ensureInitialAdmin(env.DB, env);
  const session = await readSession(request, env);
  if (!session?.user_id) {
    return null;
  }

  const user = await env.DB
    .prepare("SELECT id, username, role, telegram_id, display_name, is_active, created_at, updated_at, last_login_at FROM users WHERE id = ?")
    .bind(session.user_id)
    .first();

  return user?.is_active ? user : null;
}

export function roleLabel(role) {
  if (role === "admin") return "admin";
  if (role === "manager") return "manager";
  if (role === "editor") return "editor";
  return "viewer";
}
