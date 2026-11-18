// =====================================================================
//  server.js - serves your site, fetches game data, and runs Fan Talk
//  (accounts, favorite teams, chat). Needs Node.js 18 or newer.
//  Start it with:  node server.js
//
//  Optional settings (environment variables):
//    PORT, DATA_DIR            where to listen / where fan-data.json is kept
//    ADMIN_USERS               usernames that can open /admin (comma list)
//    CONTACT_EMAIL             shown on the rules and privacy pages
//    TRUST_PROXY=1             set when a host's proxy is in front (Render, Railway...)
//    ALLOW_LINKS=1             allow links in chat
//    BANNED_WORDS_FILE         word list (default: banned-words.txt)
//    UPSTREAM_SITE, UPSTREAM_ATHLETE   where game data comes from
// =====================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const util = require("util");
const scrypt = util.promisify(crypto.scrypt);

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "fan-data.json");
const ADMIN_USERS = (process.env.ADMIN_USERS || "").split(",")
  .map(function (n) { return n.trim().toLowerCase(); }).filter(Boolean);
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ALLOW_LINKS = process.env.ALLOW_LINKS === "1";
const WORDS_FILE = process.env.BANNED_WORDS_FILE || path.join(__dirname, "banned-words.txt");

const SESSION_DAYS = 30;
const MAX_FAVORITES = 5;
const MAX_MESSAGE_LENGTH = 300;
const MAX_STORED_MESSAGES = 5000;
const REPORTS_TO_HIDE = 3;

// ---------------------------------------------------------------------
//  Game data sources (same as before)
// ---------------------------------------------------------------------
const SOURCES = {
  "/api/site/": (process.env.UPSTREAM_SITE || "https://site.api.espn.com") + "/apis/site/v2/sports/",
  "/api/athlete/": (process.env.UPSTREAM_ATHLETE || "https://site.web.api.espn.com") + "/apis/common/v3/sports/"
};
const dataCache = {};

// ---------------------------------------------------------------------
//  Teams people can choose as favorites.
//  CHECK swac.org and meacsports.com: memberships change over time.
// ---------------------------------------------------------------------
function slug(name) {
  return name.toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const TEAM_NAMES = {
  SWAC: [
    "Alabama A&M", "Alabama State", "Alcorn State", "Arkansas-Pine Bluff",
    "Bethune-Cookman", "Florida A&M", "Grambling State", "Jackson State",
    "Mississippi Valley State", "Prairie View A&M", "Southern", "Texas Southern"
  ],
  MEAC: [
    "Coppin State", "Delaware State", "Howard", "Maryland Eastern Shore",
    "Morgan State", "Norfolk State", "North Carolina Central", "South Carolina State"
  ]
};

const TEAMS = [];
Object.keys(TEAM_NAMES).forEach(function (conf) {
  TEAM_NAMES[conf].forEach(function (name) {
    TEAMS.push({ id: slug(name), name: name, conf: conf });
  });
});

function teamName(id) {
  const team = TEAMS.find(function (t) { return t.id === id; });
  return team ? team.name : "";
}

function validRoom(room) {
  return room === "general" || TEAMS.some(function (t) { return t.id === room; });
}

const RESERVED_NAMES = ["admin", "administrator", "moderator", "mod", "staff", "support", "hbcusurge", "system"];

// ---------------------------------------------------------------------
//  Saved data (a simple file). Fine for learning and small groups.
// ---------------------------------------------------------------------
let db = { users: [], sessions: [], messages: [], reports: [], nextMessageId: 1 };

function loadDb() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    db = Object.assign(db, saved);
  } catch (error) {
    console.log("No saved Fan Talk data yet. A new file will be created.");
  }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(db));
  fs.renameSync(temp, DATA_FILE);
}

loadDb();

// ---------------------------------------------------------------------
//  Chat filter: banned words, email addresses, phone numbers, links.
//  Put your words in banned-words.txt (one per line), then restart.
// ---------------------------------------------------------------------
function squash(text) { return text.replace(/(.)\1+/g, "$1"); }   // "baaad" -> "bad"
const LEET = { "@": "a", "4": "a", "0": "o", "1": "i", "3": "e", "$": "s", "5": "s", "7": "t", "!": "i" };

let bannedWords = new Set();
try {
  bannedWords = new Set(
    fs.readFileSync(WORDS_FILE, "utf8").split(/\r?\n/)
      .map(function (line) { return line.trim().toLowerCase(); })
      .filter(function (line) { return line && line[0] !== "#"; })
      .map(squash)
  );
} catch (error) {
  console.log("No banned-words.txt found (the word filter is off until you add one).");
}

// Returns a message to show the user, or "" when the text is fine
function filterProblem(text, isUsername) {
  const lower = text.toLowerCase();
  const swapped = lower.replace(/[@04135$7!]/g, function (c) { return LEET[c]; });
  const tokens = (lower + " " + swapped).split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (bannedWords.has(squash(tokens[i]))) {
      return isUsername ? "Please choose a different username." : "That word isn't allowed here.";
    }
  }
  if (isUsername) return "";
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) return "Please don't share email addresses.";
  if (/\d{10,}/.test(text) || /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(text)) {
    return "Please don't share phone numbers.";
  }
  if (!ALLOW_LINKS && /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|gg|me|ly|tv|xyz|info|app|link)\b)/i.test(text)) {
    return "Links aren't allowed in chat.";
  }
  return "";
}

// ---------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------
function send(res, status, type, body, extra) {
  const headers = { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
  if (extra) Object.assign(headers, extra);
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj, extra) {
  const headers = { "Cache-Control": "no-store" };
  if (extra) Object.assign(headers, extra);
  send(res, status, "application/json; charset=utf-8", JSON.stringify(obj), headers);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Reads a JSON request body (max 10 KB)
function readJson(req) {
  return new Promise(function (resolve, reject) {
    if (!/application\/json/i.test(req.headers["content-type"] || "")) {
      reject(httpError(415, "Unsupported request."));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;

    req.on("data", function (chunk) {
      if (tooBig) return;
      size += chunk.length;
      if (size > 10000) {
        tooBig = true;
        reject(httpError(413, "Request too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      if (tooBig) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(httpError(400, "Invalid request."));
      }
    });
    req.on("error", reject);
  });
}

// Blocks requests that come from a different website
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === ((TRUST_PROXY && req.headers["x-forwarded-host"]) || req.headers.host);
  } catch (error) {
    return false;
  }
}

// Rate limiting: returns true if "key" did more than "max" things in "windowMs"
const hits = {};
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits[key] || []).filter(function (t) { return now - t < windowMs; });
  list.push(now);
  hits[key] = list;
  return list.length > max;
}

setInterval(function () {
  const cutoff = Date.now() - 3600000;
  Object.keys(hits).forEach(function (key) {
    const list = hits[key];
    if (list.length === 0 || list[list.length - 1] < cutoff) delete hits[key];
  });
}, 600000);

// ---------------------------------------------------------------------
//  Sessions and passwords
// ---------------------------------------------------------------------
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function getCookie(req, name) {
  const parts = (req.headers.cookie || "").split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (part.indexOf(name + "=") === 0) return decodeURIComponent(part.slice(name.length + 1));
  }
  return "";
}

function currentUser(req) {
  const token = getCookie(req, "session");
  if (!token) return null;
  const hash = sha256(token);
  const session = db.sessions.find(function (s) { return s.tokenHash === hash && s.expires > Date.now(); });
  if (!session) return null;
  const found = db.users.find(function (u) { return u.id === session.userId; }) || null;
  return found && !found.banned ? found : null;
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) {
    return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions = db.sessions.filter(function (s) { return s.expires > Date.now(); });
  db.sessions.push({
    tokenHash: sha256(token),
    userId: userId,
    expires: Date.now() + SESSION_DAYS * 86400000
  });
  return "session=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + SESSION_DAYS * 86400 +
    (TRUST_PROXY ? "; Secure" : "");
}

function isAdmin(user) {
  return !!user && ADMIN_USERS.indexOf(user.usernameLower) !== -1;
}

function publicUser(user) {
  const blocked = (user.blocked || []).map(function (id) {
    const u = db.users.find(function (x) { return x.id === id; });
    return u ? u.username : "";
  }).filter(Boolean);
  return { username: user.username, favorites: user.favorites, blocked: blocked, admin: isAdmin(user) };
}

function requireAdmin(user) {
  if (!user) throw httpError(401, "Please log in.");
  if (!isAdmin(user)) throw httpError(403, "Admins only.");
  return user;
}

// A one-time code that lets someone reset a forgotten password (no email needed)
function makeRecoveryCode() {
  return crypto.randomBytes(10).toString("hex").toUpperCase().match(/.{1,5}/g).join("-");
}

async function setRecovery(user) {
  const code = makeRecoveryCode();
  user.recSalt = crypto.randomBytes(16).toString("hex");
  user.recHash = (await scrypt(code.replace(/-/g, ""), user.recSalt, 64)).toString("hex");
  return code;
}

function requireUser(user) {
  if (!user) throw httpError(401, "Please log in.");
  return user;
}

// ---------------------------------------------------------------------
//  Fan Talk routes
// ---------------------------------------------------------------------
async function signup(req, res, ip) {
  if (limited("signup:" + ip, 5, 3600000)) {
    throw httpError(429, "Too many sign-ups from this connection. Try again later.");
  }

  const body = await readJson(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (body.ageOk !== true) {
    throw httpError(400, "Please confirm that you are 13 or older and agree to the chat rules.");
  }
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    throw httpError(400, "Usernames are 3 to 20 characters: letters, numbers and underscores only.");
  }
  if (RESERVED_NAMES.indexOf(username.toLowerCase()) !== -1) {
    throw httpError(400, "That username is reserved.");
  }
  const badName = filterProblem(username, true);
  if (badName) throw httpError(400, badName);
  if (password.length < 8 || password.length > 100) {
    throw httpError(400, "Passwords must be 8 to 100 characters.");
  }

  const lower = username.toLowerCase();
  if (db.users.some(function (u) { return u.usernameLower === lower; })) {
    throw httpError(409, "That username is taken.");
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)).toString("hex");

  // Check again, in case someone else signed up while we were hashing
  if (db.users.some(function (u) { return u.usernameLower === lower; })) {
    throw httpError(409, "That username is taken.");
  }

  const user = {
    id: crypto.randomUUID(),
    username: username,
    usernameLower: lower,
    salt: salt,
    hash: hash,
    favorites: [],
    blocked: [],
    banned: false,
    created: new Date().toISOString()
  };
  const recoveryCode = await setRecovery(user);
  db.users.push(user);

  const cookie = createSession(user.id);
  saveDb();
  sendJson(res, 200, { user: publicUser(user), recoveryCode: recoveryCode }, { "Set-Cookie": cookie });
}

// Forgot your password? Use the recovery code you were shown at sign-up.
async function recover(req, res, ip) {
  if (limited("recover:" + ip, 10, 900000)) {
    throw httpError(429, "Too many attempts. Please wait 15 minutes.");
  }
  const body = await readJson(req);
  const lower = String(body.username || "").trim().toLowerCase();
  const code = String(body.recoveryCode || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const password = String(body.newPassword || "");

  if (password.length < 8 || password.length > 100) {
    throw httpError(400, "Passwords must be 8 to 100 characters.");
  }

  const user = db.users.find(function (u) { return u.usernameLower === lower; });
  const attempt = await scrypt(code, user && user.recSalt ? user.recSalt : "00000000000000000000000000000000", 64);
  const ok = user && user.recHash && crypto.timingSafeEqual(attempt, Buffer.from(user.recHash, "hex"));
  if (!ok) throw httpError(401, "That username and recovery code don't match.");
  if (user.banned) throw httpError(403, "This account has been suspended.");

  user.salt = crypto.randomBytes(16).toString("hex");
  user.hash = (await scrypt(password, user.salt, 64)).toString("hex");
  const fresh = await setRecovery(user);                       // the old code stops working
  db.sessions = db.sessions.filter(function (s) { return s.userId !== user.id; });

  const cookie = createSession(user.id);
  saveDb();
  sendJson(res, 200, { user: publicUser(user), recoveryCode: fresh }, { "Set-Cookie": cookie });
}

async function login(req, res, ip) {
  if (limited("login:" + ip, 10, 900000)) {
    throw httpError(429, "Too many log-in attempts. Please wait 15 minutes.");
  }

  const body = await readJson(req);
  const lower = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");

  const user = db.users.find(function (u) { return u.usernameLower === lower; });

  // Always hash, so a missing username takes about as long as a wrong password
  const salt = user ? user.salt : "00000000000000000000000000000000";
  const attempt = await scrypt(password, salt, 64);
  const ok = user && crypto.timingSafeEqual(attempt, Buffer.from(user.hash, "hex"));

  if (!ok) throw httpError(401, "Incorrect username or password.");
  if (user.banned) throw httpError(403, "This account has been suspended.");

  // Accounts made before recovery codes existed get one the first time they log in
  let recoveryCode;
  if (!user.recHash) recoveryCode = await setRecovery(user);

  const cookie = createSession(user.id);
  saveDb();
  sendJson(res, 200, { user: publicUser(user), recoveryCode: recoveryCode }, { "Set-Cookie": cookie });
}

function logout(req, res) {
  const token = getCookie(req, "session");
  if (token) {
    const hash = sha256(token);
    db.sessions = db.sessions.filter(function (s) { return s.tokenHash !== hash; });
    saveDb();
  }
  sendJson(res, 200, { ok: true }, { "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
}

async function setFavorites(req, res, user) {
  const body = await readJson(req);
  const list = Array.isArray(body.teams) ? body.teams : [];
  const ids = [];

  list.forEach(function (id) {
    if (typeof id === "string" && TEAMS.some(function (t) { return t.id === id; }) && ids.indexOf(id) === -1) {
      ids.push(id);
    }
  });

  if (ids.length > MAX_FAVORITES) {
    throw httpError(400, "You can pick up to " + MAX_FAVORITES + " favorite teams.");
  }

  user.favorites = ids;
  saveDb();
  sendJson(res, 200, { user: publicUser(user) });
}

// How many different people reported each message
function reportCounts() {
  const counts = {};
  db.reports.forEach(function (r) { counts[r.messageId] = (counts[r.messageId] || 0) + 1; });
  return counts;
}

function toPublicMessage(message, viewer) {
  const author = db.users.find(function (u) { return u.id === message.userId; });
  return {
    id: message.id,
    text: message.text,
    time: message.time,
    username: author ? author.username : "deleted user",
    favTeam: author && author.favorites.length > 0 ? teamName(author.favorites[0]) : "",
    mine: message.userId === viewer.id
  };
}

function getMessages(url, res, user) {
  const room = url.searchParams.get("room");
  if (!validRoom(room)) throw httpError(400, "Unknown room.");
  const after = parseInt(url.searchParams.get("after"), 10) || 0;

  const counts = reportCounts();
  const blocked = user.blocked || [];
  const visible = db.messages.filter(function (m) {
    return m.room === room && (counts[m.id] || 0) < REPORTS_TO_HIDE && blocked.indexOf(m.userId) === -1;
  });

  const latest = visible.slice(-100);
  const fresh = latest.filter(function (m) { return m.id > after; });

  sendJson(res, 200, {
    messages: fresh.map(function (m) { return toPublicMessage(m, user); }),
    visibleIds: latest.map(function (m) { return m.id; })
  });
}

async function postMessage(req, res, user) {
  const body = await readJson(req);
  const room = body.room;
  if (!validRoom(room)) throw httpError(400, "Unknown room.");

  if (limited("msg:" + user.id, 5, 10000)) {
    throw httpError(429, "Slow down a little.");
  }

  let text = String(body.text || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length === 0) throw httpError(400, "Type a message first.");
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw httpError(400, "Messages can be up to " + MAX_MESSAGE_LENGTH + " characters.");
  }

  const problem = filterProblem(text, false);
  if (problem) throw httpError(400, problem);

  // Block repeating the same message
  const mine = db.messages.filter(function (m) { return m.userId === user.id; });
  const lastMine = mine[mine.length - 1];
  if (lastMine && lastMine.text === text && Date.now() - new Date(lastMine.time).getTime() < 30000) {
    throw httpError(400, "Please don't repeat the same message.");
  }

  const message = {
    id: db.nextMessageId++,
    room: room,
    userId: user.id,
    text: text,
    time: new Date().toISOString()
  };
  db.messages.push(message);

  if (db.messages.length > MAX_STORED_MESSAGES) {
    db.messages = db.messages.slice(-MAX_STORED_MESSAGES);
  }

  saveDb();
  sendJson(res, 200, { message: toPublicMessage(message, user) });
}

async function deleteMessage(req, res, user) {
  const body = await readJson(req);
  const id = parseInt(body.id, 10);
  const message = db.messages.find(function (m) { return m.id === id; });

  if (!message || message.userId !== user.id) {
    throw httpError(404, "Message not found.");
  }

  db.messages = db.messages.filter(function (m) { return m.id !== id; });
  db.reports = db.reports.filter(function (r) { return r.messageId !== id; });
  saveDb();
  sendJson(res, 200, { ok: true });
}

async function reportMessage(req, res, user) {
  const body = await readJson(req);
  const id = parseInt(body.id, 10);
  const message = db.messages.find(function (m) { return m.id === id; });

  if (!message) throw httpError(404, "Message not found.");
  if (message.userId === user.id) throw httpError(400, "You can't report your own message.");

  const already = db.reports.some(function (r) { return r.messageId === id && r.userId === user.id; });
  if (!already) {
    db.reports.push({ messageId: id, userId: user.id, time: new Date().toISOString() });
    saveDb();
  }
  sendJson(res, 200, { ok: true });
}

// Hide (or show again) one person's messages, for you only
async function blockUser(req, res, user, shouldBlock) {
  const body = await readJson(req);
  const lower = String(body.username || "").trim().toLowerCase();
  const target = db.users.find(function (u) { return u.usernameLower === lower; });
  if (!target) throw httpError(404, "No such user.");
  if (target.id === user.id) throw httpError(400, "You can't block yourself.");

  user.blocked = (user.blocked || []).filter(function (id) { return id !== target.id; });
  if (shouldBlock) user.blocked.push(target.id);
  saveDb();
  sendJson(res, 200, { user: publicUser(user) });
}

// ----- Admin tools (only for usernames listed in ADMIN_USERS) -----
function adminOverview(res) {
  const counts = reportCounts();
  const reported = db.messages
    .filter(function (m) { return counts[m.id]; })
    .sort(function (a, b) { return counts[b.id] - counts[a.id] || b.id - a.id; })
    .slice(0, 100)
    .map(function (m) {
      const author = db.users.find(function (u) { return u.id === m.userId; });
      return {
        id: m.id, room: m.room, user: author ? author.username : "deleted user", text: m.text,
        time: m.time, reports: counts[m.id], hidden: counts[m.id] >= REPORTS_TO_HIDE
      };
    });
  const users = db.users.slice().reverse().slice(0, 200).map(function (u) {
    return { username: u.username, banned: !!u.banned, created: u.created, admin: isAdmin(u) };
  });
  sendJson(res, 200, { reported: reported, users: users });
}

async function adminAction(req, res, action) {
  const body = await readJson(req);

  if (action === "delete" || action === "dismiss") {
    const id = parseInt(body.id, 10);
    const message = db.messages.find(function (m) { return m.id === id; });
    if (!message) throw httpError(404, "Message not found.");
    db.reports = db.reports.filter(function (r) { return r.messageId !== id; });
    if (action === "delete") db.messages = db.messages.filter(function (m) { return m.id !== id; });
    saveDb();
    sendJson(res, 200, { ok: true });
    return;
  }

  const target = db.users.find(function (u) {
    return u.usernameLower === String(body.username || "").toLowerCase();
  });
  if (!target) throw httpError(404, "No such user.");

  if (action === "ban") {
    if (isAdmin(target)) throw httpError(400, "You can't suspend an admin.");
    target.banned = true;
    db.sessions = db.sessions.filter(function (s) { return s.userId !== target.id; });
  } else if (action === "unban") {
    target.banned = false;
  } else if (action === "reset-password") {
    const temp = crypto.randomBytes(6).toString("hex");
    target.salt = crypto.randomBytes(16).toString("hex");
    target.hash = (await scrypt(temp, target.salt, 64)).toString("hex");
    db.sessions = db.sessions.filter(function (s) { return s.userId !== target.id; });
    saveDb();
    sendJson(res, 200, { temporaryPassword: temp });
    return;
  } else {
    throw httpError(404, "Not found.");
  }
  saveDb();
  sendJson(res, 200, { ok: true });
}

async function handleFan(req, res, url) {
  const ip = clientIp(req);

  if (req.method === "POST" && !sameOrigin(req)) {
    throw httpError(403, "Blocked request.");
  }

  const user = currentUser(req);
  const route = req.method + " " + url.pathname;

  switch (route) {
    case "GET /fan/teams":
      return sendJson(res, 200, { teams: TEAMS, maxFavorites: MAX_FAVORITES, maxLength: MAX_MESSAGE_LENGTH });
    case "GET /fan/me":
      return sendJson(res, 200, { user: user ? publicUser(user) : null });
    case "POST /fan/signup":
      return signup(req, res, ip);
    case "POST /fan/login":
      return login(req, res, ip);
    case "POST /fan/logout":
      return logout(req, res);
    case "POST /fan/favorites":
      return setFavorites(req, res, requireUser(user));
    case "GET /fan/messages":
      return getMessages(url, res, requireUser(user));
    case "POST /fan/messages":
      return postMessage(req, res, requireUser(user));
    case "POST /fan/delete":
      return deleteMessage(req, res, requireUser(user));
    case "POST /fan/report":
      return reportMessage(req, res, requireUser(user));
    case "GET /fan/config":
      return sendJson(res, 200, { contact: CONTACT_EMAIL });
    case "POST /fan/recover":
      return recover(req, res, ip);
    case "POST /fan/block":
      return blockUser(req, res, requireUser(user), true);
    case "POST /fan/unblock":
      return blockUser(req, res, requireUser(user), false);
    case "GET /fan/admin/overview":
      requireAdmin(user);
      return adminOverview(res);
  }

  if (req.method === "POST" && url.pathname.indexOf("/fan/admin/") === 0) {
    requireAdmin(user);
    return adminAction(req, res, url.pathname.slice("/fan/admin/".length));
  }

  throw httpError(404, "Not found.");
}

// ---------------------------------------------------------------------
//  Web pages
// ---------------------------------------------------------------------
const TEAMS_BUTTON = '<button class="view-btn" data-view="teams">Teams</button>';
const FAN_LINK =
  '<a href="/fan-talk" style="background:#2a2a2a;color:#ddd;border-radius:999px;' +
  'padding:0.4rem 1rem;font-size:0.8rem;font-weight:700;text-transform:uppercase;' +
  'text-decoration:none;display:inline-block">Fan Talk</a>';

function servePage(res, fileName, transform) {
  const file = path.join(__dirname, fileName);
  if (!fs.existsSync(file)) {
    send(res, 404, "text/plain; charset=utf-8", fileName + " was not found next to server.js.");
    return;
  }
  let html = fs.readFileSync(file, "utf8");
  if (transform) html = transform(html);
  send(res, 200, "text/html; charset=utf-8", html);
}

// ---------------------------------------------------------------------
//  The server
// ---------------------------------------------------------------------
const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    // Fan Talk
    if (pathname.startsWith("/fan/")) {
      await handleFan(req, res, url);
      return;
    }
    // Quick check you can open in a browser: /api/check
    if (pathname === "/api/check") {
      const testUrl = SOURCES["/api/site/"] + "football/college-football/scoreboard?groups=81&limit=1";
      let report;
      try {
        const r = await fetch(testUrl);
        const t = await r.text();
        report = { status: r.status, starts: t.slice(0, 200), url: testUrl };
      } catch (e) {
        report = { error: String(e && e.message), cause: String(e && e.cause && (e.cause.code || e.cause.message)), url: testUrl };
      }
      sendJson(res, 200, report);
      return;
    }
    // Game data
    for (const prefix in SOURCES) {
      if (pathname.startsWith(prefix)) {
        const target = SOURCES[prefix] + req.url.slice(prefix.length);
        const hit = dataCache[target];

        // Scoreboards are kept for a short time so live scores stay fresh
        const keepFor = target.indexOf("/scoreboard") !== -1 ? 15000 : 60000;
        if (hit && Date.now() - hit.time < keepFor) {
          send(res, 200, "application/json", hit.body);
          return;
        }

        const upstream = await fetch(target);
        const body = await upstream.text();
        if (upstream.ok) dataCache[target] = { time: Date.now(), body: body };
        send(res, upstream.status, "application/json", body);
        return;
      }
    }

    // Pages
        // Small static files (app icon and install info)
    const STATIC_FILES = { "/manifest.json": "application/manifest+json", "/icon.svg": "image/svg+xml" };
    if (STATIC_FILES[pathname]) {
      const staticFile = path.join(__dirname, pathname.slice(1));
      if (fs.existsSync(staticFile)) {
        send(res, 200, STATIC_FILES[pathname], fs.readFileSync(staticFile));
        return;
      }
    }
    if (pathname === "/" || pathname === "/index.html") {
      servePage(res, "index.html", function (html) {
        if (html.indexOf("/fan-talk") !== -1) return html;
        return html.replace(TEAMS_BUTTON, function () { return TEAMS_BUTTON + FAN_LINK; });
      });
      return;
    }

    if (pathname === "/fan-talk" || pathname === "/fan-talk.html") {
      servePage(res, "fan-talk.html");
      return;
    }

    const EXTRA_PAGES = {
      "/admin": "admin.html", "/admin.html": "admin.html",
      "/rules": "rules.html", "/rules.html": "rules.html",
      "/privacy": "privacy.html", "/privacy.html": "privacy.html"
    };
    if (EXTRA_PAGES[pathname]) {
      servePage(res, EXTRA_PAGES[pathname]);
      return;
    }

    send(res, 404, "text/plain; charset=utf-8", "Not found");
  } catch (error) {
    if (error.status) {
      sendJson(res, error.status, { error: error.message });
    } else {
      console.error(error);
      sendJson(res, 500, { error: "Something went wrong. Please try again." });
    }
  }
});

server.listen(PORT, function () {
  console.log("Site running at http://localhost:" + PORT);
  console.log("Fan Talk at   http://localhost:" + PORT + "/fan-talk");
  if (ADMIN_USERS.length === 0) console.log("Tip: set ADMIN_USERS=yourusername to use /admin");
});
