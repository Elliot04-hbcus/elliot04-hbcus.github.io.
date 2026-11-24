// =====================================================================
//  server.js - serves your site, fetches game data, and runs Fan Talk
//  (accounts, favorite teams, chat). Needs Node.js 18 or newer.
//  Start it with:  node server.js
//
//  Optional settings (environment variables):
//    PORT, DATA_DIR            where to listen / where fan-data.json and recruit-data.json are kept
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

// Reads a JSON request body (max 10 KB unless a bigger limit is given)
function readJson(req, maxBytes) {
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
      if (size > (maxBytes || 10000)) {
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
//  Recruiting: a locked area for verified players and coaches.
//  Everything here needs a Fan Talk login AND approval from an admin.
//  Saved in recruit-data.json (separate from the Fan Talk data).
//  Players and coaches only ever see each other through this area:
//  email addresses and phone numbers are never shown, and messages that
//  contain them are blocked.
// ---------------------------------------------------------------------
const RDATA_FILE = path.join(DATA_DIR, "recruit-data.json");
let rdb = { apps: [], profiles: [], threads: [], messages: [], reports: [] };

function loadRdb() {
  try {
    rdb = Object.assign(rdb, JSON.parse(fs.readFileSync(RDATA_FILE, "utf8")));
  } catch (error) {
    console.log("No saved recruiting data yet. A new file will be created.");
  }
}

function saveRdb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = RDATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(rdb));
  fs.renameSync(temp, RDATA_FILE);
}

loadRdb();

const SPORTS = { football: "Football", mbb: "Men's basketball", wbb: "Women's basketball" };
const POSITIONS = {
  football: ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "K", "P", "ATH"],
  mbb: ["PG", "SG", "SF", "PF", "C", "G", "F"],
  wbb: ["PG", "SG", "SF", "PF", "C", "G", "F"]
};
const MEASURABLES = {
  football: { forty: [3.8, 7, "40-yard dash (sec)"], vertical: [10, 60, "Vertical (in)"], bench: [50, 600, "Bench (lbs)"], squat: [50, 900, "Squat (lbs)"] },
  mbb: { wingspan: [60, 100, "Wingspan (in)"], vertical: [10, 60, "Vertical (in)"], sprint: [2, 6, "3/4 court sprint (sec)"] },
  wbb: { wingspan: [55, 95, "Wingspan (in)"], vertical: [8, 50, "Vertical (in)"], sprint: [2, 6, "3/4 court sprint (sec)"] }
};
const VIDEO_HOSTS = ["youtube.com", "youtu.be", "hudl.com", "vimeo.com"];
const MAX_THREAD_MESSAGES = 300;

function rid() { return crypto.randomBytes(6).toString("hex"); }

// Plain text only: no angle brackets or control characters
function clean(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function need(value, min, max, label) {
  const text = clean(value, max);
  if (text.length < min) throw httpError(400, label + " is required.");
  return text;
}

function num(value, min, max, label, decimals) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  if (!isFinite(n) || n < min || n > max) throw httpError(400, label + " must be between " + min + " and " + max + ".");
  const p = Math.pow(10, decimals || 0);
  return Math.round(n * p) / p;
}

function httpsUrl(value, hosts, label) {
  const text = String(value || "").trim();
  if (!text) return "";
  let u;
  try { u = new URL(text); } catch (e) { throw httpError(400, label + " must be a full web address starting with https://"); }
  if (u.protocol !== "https:") throw httpError(400, label + " must start with https://");
  if (hosts) {
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!hosts.some(function (h) { return host === h || host.endsWith("." + h); })) {
      throw httpError(400, label + " must be a link from " + hosts.join(", ") + ".");
    }
  }
  return u.href.slice(0, 300);
}

function checkText(text) {
  const problem = text ? filterProblem(text, false) : "";
  if (problem) throw httpError(400, problem);
}

function ageFrom(birthDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthDate || ""));
  if (!m) throw httpError(400, "Please enter a valid date of birth.");
  const y = +m[1], mo = +m[2], d = +m[3];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw httpError(400, "Please enter a valid date of birth.");
  }
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age--;
  if (age < 13) throw httpError(403, "Players must be 13 or older to use recruiting.");
  if (age > 45) throw httpError(400, "Please check the date of birth.");
  return { age: age, year: y };
}

function getApp(user) {
  return rdb.apps.find(function (a) { return a.userId === user.id; }) || null;
}

function appById(id) {
  return rdb.apps.find(function (a) { return a.id === id; }) || null;
}

function requireApproved(user, role) {
  const app = getApp(user);
  if (!app) throw httpError(403, "Request access first.");
  if (app.status === "pending") throw httpError(403, "Your request is still being reviewed.");
  if (app.status === "rejected") throw httpError(403, "Your request was not approved.");
  if (app.status === "suspended") throw httpError(403, "This recruiting account is suspended.");
  if (role && app.role !== role) throw httpError(403, "That isn't available for your account type.");
  return app;
}

function teamOf(app) { return app.role === "coach" ? teamName(app.teamId) : ""; }

// What a person sees about their own request
function myApp(app) {
  return {
    id: app.id, role: app.role, status: app.status, note: app.status === "rejected" ? app.note || "" : "",
    fullName: app.fullName, minor: !!app.minor, sport: app.sport || "", sports: app.sports || [],
    teamId: app.teamId || "", teamName: teamOf(app), title: app.title || "", level: app.level || ""
  };
}

function ensureProfile(app) {
  let p = rdb.profiles.find(function (x) { return x.userId === app.userId; });
  if (!p) {
    p = {
      id: rid(), userId: app.userId, active: false, allowMessages: false, sport: app.sport, gradYear: app.gradYear,
      hsSchool: app.hsSchool, city: app.city, state: app.state, position: "", position2: "", height: null,
      weight: null, club: "", gpa: null, sat: null, act: null, major: "", measurables: {}, stats: [],
      highlightUrl: "", bio: "", status: "open", committedTo: "", offers: [], updated: Date.now()
    };
    rdb.profiles.push(p);
  }
  return p;
}

function completeness(p) {
  const checks = [p.position, p.height, p.weight, p.gpa !== null, p.highlightUrl, p.bio,
    Object.keys(p.measurables || {}).length > 0, (p.stats || []).length > 0, p.major, p.sat || p.act];
  return Math.round(checks.filter(Boolean).length / checks.length * 100);
}

function summaryOf(p, app) {
  return {
    id: p.id, name: app.fullName, sport: p.sport, position: p.position, gradYear: p.gradYear,
    height: p.height, weight: p.weight, hsSchool: p.hsSchool, city: p.city, state: p.state, gpa: p.gpa,
    status: p.status, minor: !!app.minor, level: app.level, allowMessages: !!p.allowMessages,
    complete: completeness(p), updated: p.updated
  };
}

function fullProfile(p, app) {
  const s = summaryOf(p, app);
  s.position2 = p.position2; s.club = p.club; s.sat = p.sat; s.act = p.act; s.major = p.major;
  s.measurables = p.measurables; s.stats = p.stats; s.highlightUrl = p.highlightUrl; s.bio = p.bio;
  s.committedTo = p.committedTo; s.offers = p.offers; s.active = !!p.active;
  return s;
}

// ----- Requests for access -----
async function recruitApply(req, res, user) {
  if (limited("rapply:" + user.id, 6, 86400000)) throw httpError(429, "Too many tries today. Please try again tomorrow.");
  const existing = getApp(user);
  if (existing && existing.status !== "rejected") throw httpError(409, "You already have a request.");

  const body = await readJson(req, 20000);
  if (body.agree !== true) throw httpError(400, "Please read and agree to the recruiting terms.");
  const app = { id: rid(), userId: user.id, role: body.role, status: "pending", created: Date.now(), note: "" };

  if (body.role === "coach") {
    app.fullName = need(body.fullName, 2, 60, "Your name");
    if (!TEAMS.some(function (t) { return t.id === body.teamId; })) throw httpError(400, "Please choose your school.");
    app.teamId = body.teamId;
    app.title = need(body.title, 2, 60, "Your job title");
    app.sports = (Array.isArray(body.sports) ? body.sports : []).filter(function (s) { return SPORTS[s]; });
    if (app.sports.length === 0) throw httpError(400, "Choose at least one sport you recruit for.");
    app.staffUrl = httpsUrl(body.staffUrl, null, "The staff page link");
    if (!app.staffUrl) throw httpError(400, "The staff page link is required so we can verify you.");
    app.schoolEmail = clean(body.schoolEmail, 100).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.edu$/.test(app.schoolEmail)) throw httpError(400, "Please enter your school email (it must end in .edu).");
  } else if (body.role === "player") {
    app.fullName = need(body.fullName, 2, 60, "Your name");
    const age = ageFrom(body.birthDate);
    app.minor = age.age < 18;
    app.birthYear = age.year;
    app.level = body.level === "transfer" ? "transfer" : "highschool";
    if (!SPORTS[body.sport]) throw httpError(400, "Please choose your sport.");
    app.sport = body.sport;
    app.gradYear = num(body.gradYear, 2026, 2032, "Class year", 0);
    if (app.gradYear === null) throw httpError(400, "Class year is required.");
    app.hsSchool = need(body.hsSchool, 2, 80, "Your school");
    app.city = need(body.city, 2, 50, "Your city");
    app.state = String(body.state || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(app.state)) throw httpError(400, "Use the two-letter state, like MS.");
    app.refName = need(body.refName, 2, 60, "The coach or school contact's name");
    app.refContact = need(body.refContact, 5, 120, "The coach or school contact's email or phone");
    if (app.minor) {
      const g = body.guardian || {};
      app.guardian = {
        name: need(g.name, 2, 60, "Parent or guardian name"),
        relationship: need(g.relationship, 2, 30, "Relationship"),
        email: clean(g.email, 100).toLowerCase(),
        phone: need(g.phone, 7, 20, "Parent or guardian phone")
      };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(app.guardian.email)) throw httpError(400, "Please enter the parent or guardian's email.");
      if (g.consent !== true) throw httpError(400, "A parent or guardian must agree before a player under 18 can join.");
    }
  } else {
    throw httpError(400, "Choose player or coach.");
  }

  if (existing) rdb.apps = rdb.apps.filter(function (a) { return a !== existing; });
  rdb.apps.push(app);
  saveRdb();
  sendJson(res, 200, { app: myApp(app) });
}

function recruitMe(res, user) {
  const app = getApp(user);
  const out = { username: user.username, app: app ? myApp(app) : null, admin: isAdmin(user) };
  if (app && app.status === "approved") {
    if (app.role === "player") {
      const p = ensureProfile(app);
      saveRdb();
      out.profile = fullProfile(p, app);
      out.positions = POSITIONS[p.sport];
      out.measurables = MEASURABLES[p.sport];
    }
    out.unread = rdb.threads.reduce(function (sum, t) {
      if (app.role === "coach" && t.coachId === user.id) return sum + (t.coachUnread || 0);
      if (app.role === "player" && t.playerId === user.id) return sum + (t.playerUnread || 0);
      return sum;
    }, 0);
  }
  sendJson(res, 200, out);
}

// ----- Player profile -----
async function saveProfile(req, res, user) {
  const app = requireApproved(user, "player");
  const p = ensureProfile(app);
  const b = await readJson(req, 20000);

  const position = clean(b.position, 4);
  if (position && POSITIONS[p.sport].indexOf(position) === -1) throw httpError(400, "Choose a position from the list.");
  const position2 = clean(b.position2, 4);
  if (position2 && POSITIONS[p.sport].indexOf(position2) === -1) throw httpError(400, "Choose a second position from the list.");

  const next = {
    position: position, position2: position2,
    height: num(b.height, 48, 96, "Height", 0), weight: num(b.weight, 80, 450, "Weight", 0),
    club: clean(b.club, 60), gpa: num(b.gpa, 0, 4.5, "GPA", 2),
    sat: num(b.sat, 400, 1600, "SAT", 0), act: num(b.act, 1, 36, "ACT", 0),
    major: clean(b.major, 60), highlightUrl: httpsUrl(b.highlightUrl, VIDEO_HOSTS, "The highlight video link"),
    bio: clean(b.bio, 600), committedTo: clean(b.committedTo, 60)
  };
  next.status = ["open", "committed", "signed"].indexOf(b.status) !== -1 ? b.status : "open";
  if (next.status === "open") next.committedTo = "";

  next.measurables = {};
  const spec = MEASURABLES[p.sport];
  Object.keys(spec).forEach(function (key) {
    const v = num((b.measurables || {})[key], spec[key][0], spec[key][1], spec[key][2], 2);
    if (v !== null) next.measurables[key] = v;
  });

  next.stats = (Array.isArray(b.stats) ? b.stats : []).slice(0, 6).map(function (row) {
    return { season: clean(row && row.season, 20), line: clean(row && row.line, 140) };
  }).filter(function (row) { return row.season || row.line; });

  next.offers = (Array.isArray(b.offers) ? b.offers : []).slice(0, 8).map(function (o) {
    const st = ["offer", "interest", "visit"].indexOf(o && o.status) !== -1 ? o.status : "interest";
    return { school: clean(o && o.school, 60), status: st };
  }).filter(function (o) { return o.school; });

  [next.bio, next.club, next.major, next.committedTo].concat(
    next.stats.map(function (r) { return r.season + " " + r.line; }),
    next.offers.map(function (o) { return o.school; })
  ).forEach(checkText);

  next.allowMessages = b.allowMessages === true;
  next.active = b.active === true;
  if (next.active && (!next.position || !next.height || !next.weight)) {
    throw httpError(400, "Add your position, height and weight before turning your profile on.");
  }

  Object.assign(p, next, { updated: Date.now() });
  saveRdb();
  sendJson(res, 200, { profile: fullProfile(p, app) });
}

// ----- Coach: search, view, board -----
function coachPlayers(app) {
  return rdb.profiles.filter(function (p) {
    const pa = rdb.apps.find(function (a) { return a.userId === p.userId; });
    return p.active && pa && pa.status === "approved" && app.sports.indexOf(p.sport) !== -1;
  });
}

function searchPlayers(url, res, user) {
  const app = requireApproved(user, "coach");
  if (limited("rsearch:" + user.id, 150, 3600000)) throw httpError(429, "Too many searches. Please wait a bit.");
  const q = url.searchParams;
  const sport = q.get("sport") || "", year = q.get("year") || "", pos = q.get("pos") || "";
  const state = (q.get("state") || "").toUpperCase(), status = q.get("status") || "";
  const minGpa = parseFloat(q.get("minGpa") || ""), text = (q.get("q") || "").toLowerCase().trim();

  let list = coachPlayers(app).filter(function (p) {
    const pa = rdb.apps.find(function (a) { return a.userId === p.userId; });
    if (sport && p.sport !== sport) return false;
    if (year && String(p.gradYear) !== year) return false;
    if (pos && p.position !== pos && p.position2 !== pos) return false;
    if (state && p.state !== state) return false;
    if (status && p.status !== status) return false;
    if (isFinite(minGpa) && (p.gpa === null || p.gpa < minGpa)) return false;
    if (text && (pa.fullName + " " + p.hsSchool + " " + p.city).toLowerCase().indexOf(text) === -1) return false;
    return true;
  });
  list.sort(function (a, b) { return b.updated - a.updated; });
  const total = list.length;
  const out = list.slice(0, 60).map(function (p) {
    return summaryOf(p, rdb.apps.find(function (a) { return a.userId === p.userId; }));
  });
  sendJson(res, 200, { players: out, total: total, board: app.board || [], sports: app.sports });
}

function viewPlayer(url, res, user) {
  const app = requireApproved(user, "coach");
  if (limited("rview:" + user.id, 300, 3600000)) throw httpError(429, "Too many profile views. Please wait a bit.");
  const p = coachPlayers(app).find(function (x) { return x.id === url.searchParams.get("id"); });
  if (!p) throw httpError(404, "That profile isn't available.");
  const pa = rdb.apps.find(function (a) { return a.userId === p.userId; });
  const thread = rdb.threads.find(function (t) { return t.coachId === user.id && t.playerId === p.userId; });
  const out = fullProfile(p, pa);
  out.onBoard = (app.board || []).indexOf(p.id) !== -1;
  out.threadId = thread ? thread.id : "";
  sendJson(res, 200, { profile: out });
}

async function boardToggle(req, res, user) {
  const app = requireApproved(user, "coach");
  const b = await readJson(req);
  const p = coachPlayers(app).find(function (x) { return x.id === b.id; });
  if (!p) throw httpError(404, "That profile isn't available.");
  app.board = (app.board || []).filter(function (id) { return id !== p.id; });
  if (b.on === true) app.board.push(p.id);
  if (app.board.length > 200) throw httpError(400, "Your board is full.");
  saveRdb();
  sendJson(res, 200, { board: app.board });
}

function boardList(res, user) {
  const app = requireApproved(user, "coach");
  const list = coachPlayers(app).filter(function (p) { return (app.board || []).indexOf(p.id) !== -1; })
    .map(function (p) { return summaryOf(p, rdb.apps.find(function (a) { return a.userId === p.userId; })); });
  sendJson(res, 200, { players: list });
}

// ----- Messages -----
function messageText(value) {
  const text = clean(value, 1000);
  if (!text) throw httpError(400, "Write a message first.");
  const problem = filterProblem(text, false);
  if (problem) throw httpError(400, problem + " (To protect players, contact details can't be shared here.)");
  return text;
}

function addMessage(thread, from, text) {
  const count = rdb.messages.filter(function (m) { return m.threadId === thread.id; }).length;
  if (count >= MAX_THREAD_MESSAGES) throw httpError(400, "This conversation is full.");
  rdb.messages.push({ id: rid(), threadId: thread.id, from: from, text: text, time: Date.now() });
  thread.last = Date.now();
  if (from === "coach") thread.playerUnread = (thread.playerUnread || 0) + 1;
  else thread.coachUnread = (thread.coachUnread || 0) + 1;
}

async function startThread(req, res, user) {
  const app = requireApproved(user, "coach");
  if (limited("rthread:" + user.id, 20, 86400000)) throw httpError(429, "You've reached today's limit for new conversations.");
  const b = await readJson(req);
  const p = coachPlayers(app).find(function (x) { return x.id === b.playerId; });
  if (!p) throw httpError(404, "That profile isn't available.");
  if (!p.allowMessages) throw httpError(403, "This player isn't accepting messages right now.");
  const text = messageText(b.text);
  let thread = rdb.threads.find(function (t) { return t.coachId === user.id && t.playerId === p.userId; });
  if (thread && thread.blocked) throw httpError(403, "This player isn't accepting messages from you.");
  if (!thread) {
    thread = { id: rid(), coachId: user.id, playerId: p.userId, teamId: app.teamId, created: Date.now(), last: Date.now(), blocked: false, coachUnread: 0, playerUnread: 0 };
    rdb.threads.push(thread);
  }
  addMessage(thread, "coach", text);
  saveRdb();
  sendJson(res, 200, { threadId: thread.id });
}

function threadFor(user, id) {
  const app = requireApproved(user);
  const t = rdb.threads.find(function (x) { return x.id === id; });
  if (!t || (t.coachId !== user.id && t.playerId !== user.id)) throw httpError(404, "Conversation not found.");
  return { t: t, app: app };
}

function listThreads(res, user) {
  const app = requireApproved(user);
  const mine = rdb.threads.filter(function (t) { return app.role === "coach" ? t.coachId === user.id : t.playerId === user.id; });
  mine.sort(function (a, b) { return b.last - a.last; });
  const out = mine.map(function (t) {
    const other = rdb.apps.find(function (a) { return a.userId === (app.role === "coach" ? t.playerId : t.coachId); });
    const msgs = rdb.messages.filter(function (m) { return m.threadId === t.id; });
    const last = msgs[msgs.length - 1];
    return {
      id: t.id, with: other ? other.fullName : "Removed account",
      detail: other ? (other.role === "coach" ? other.title + ", " + teamOf(other) : SPORTS[other.sport] + " · Class of " + other.gradYear) : "",
      preview: last ? last.text.slice(0, 80) : "", last: t.last, blocked: !!t.blocked,
      unread: app.role === "coach" ? t.coachUnread || 0 : t.playerUnread || 0
    };
  });
  sendJson(res, 200, { threads: out });
}

function getThread(url, res, user) {
  const found = threadFor(user, url.searchParams.get("id"));
  const t = found.t, role = found.app.role;
  if (role === "coach") t.coachUnread = 0; else t.playerUnread = 0;
  saveRdb();
  const msgs = rdb.messages.filter(function (m) { return m.threadId === t.id; })
    .map(function (m) { return { id: m.id, mine: m.from === role, text: m.text, time: m.time }; });
  sendJson(res, 200, { id: t.id, blocked: !!t.blocked, messages: msgs });
}

async function sendMessage(req, res, user) {
  if (limited("rmsg:" + user.id, 30, 600000)) throw httpError(429, "You're sending messages too fast.");
  const b = await readJson(req);
  const found = threadFor(user, b.threadId);
  if (found.t.blocked) throw httpError(403, "This conversation is closed.");
  if (found.app.role === "coach" && found.t.coachId === user.id) {
    const p = rdb.profiles.find(function (x) { return x.userId === found.t.playerId; });
    if (!p || !p.allowMessages || !p.active) throw httpError(403, "This player isn't accepting messages right now.");
  }
  addMessage(found.t, found.app.role, messageText(b.text));
  saveRdb();
  sendJson(res, 200, { ok: true });
}

async function blockThread(req, res, user) {
  const b = await readJson(req);
  const found = threadFor(user, b.threadId);
  if (found.app.role !== "player") throw httpError(403, "Only players can block.");
  found.t.blocked = b.on !== false;
  saveRdb();
  sendJson(res, 200, { ok: true });
}

async function reportThread(req, res, user) {
  if (limited("rreport:" + user.id, 10, 86400000)) throw httpError(429, "Too many reports today.");
  const b = await readJson(req);
  const found = threadFor(user, b.threadId);
  rdb.reports.push({ id: rid(), threadId: found.t.id, reporterId: user.id, reason: clean(b.reason, 300) || "No reason given", time: Date.now(), resolved: false });
  saveRdb();
  sendJson(res, 200, { ok: true });
}

// ----- Delete my recruiting data -----
async function deleteMyRecruiting(req, res, user) {
  const b = await readJson(req);
  if (b.confirm !== "DELETE") throw httpError(400, "Type DELETE to confirm.");
  const gone = rdb.threads.filter(function (t) { return t.coachId === user.id || t.playerId === user.id; })
    .map(function (t) { return t.id; });
  rdb.threads = rdb.threads.filter(function (t) { return gone.indexOf(t.id) === -1; });
  rdb.messages = rdb.messages.filter(function (m) { return gone.indexOf(m.threadId) === -1; });
  rdb.reports = rdb.reports.filter(function (r) { return gone.indexOf(r.threadId) === -1; });
  rdb.profiles = rdb.profiles.filter(function (p) { return p.userId !== user.id; });
  rdb.apps = rdb.apps.filter(function (a) { return a.userId !== user.id; });
  saveRdb();
  sendJson(res, 200, { ok: true });
}

// ----- Admin review -----
function adminRecruit(res) {
  function who(a) {
    const u = db.users.find(function (x) { return x.id === a.userId; });
    return u ? u.username : "(removed)";
  }
  function full(a) {
    return Object.assign({}, a, { username: who(a), teamName: teamOf(a), userId: undefined });
  }
  const reports = rdb.reports.filter(function (r) { return !r.resolved; }).map(function (r) {
    const t = rdb.threads.find(function (x) { return x.id === r.threadId; });
    const coach = t && rdb.apps.find(function (a) { return a.userId === t.coachId; });
    const player = t && rdb.apps.find(function (a) { return a.userId === t.playerId; });
    return {
      id: r.id, reason: r.reason, time: r.time, coachId: coach ? coach.id : "", coachName: coach ? coach.fullName : "?",
      coachTeam: coach ? teamOf(coach) : "", playerName: player ? player.fullName : "?",
      playerMinor: !!(player && player.minor),
      messages: rdb.messages.filter(function (m) { return t && m.threadId === t.id; })
        .map(function (m) { return { from: m.from, text: m.text, time: m.time }; })
    };
  });
  sendJson(res, 200, {
    pending: rdb.apps.filter(function (a) { return a.status === "pending"; }).map(full),
    approved: rdb.apps.filter(function (a) { return a.status === "approved"; }).map(function (a) {
      return { id: a.id, role: a.role, fullName: a.fullName, username: who(a), status: a.status, teamName: teamOf(a), sport: a.sport || (a.sports || []).join(", "), minor: !!a.minor };
    }),
    suspended: rdb.apps.filter(function (a) { return a.status === "suspended" || a.status === "rejected"; }).map(function (a) {
      return { id: a.id, role: a.role, fullName: a.fullName, username: who(a), status: a.status, teamName: teamOf(a) };
    }),
    reports: reports
  });
}

async function adminRecruitAction(req, res, action) {
  const b = await readJson(req);
  if (action === "dismiss-report") {
    const r = rdb.reports.find(function (x) { return x.id === b.id; });
    if (!r) throw httpError(404, "Report not found.");
    r.resolved = true;
    saveRdb();
    return sendJson(res, 200, { ok: true });
  }
  const app = appById(b.id);
  if (!app) throw httpError(404, "Request not found.");
  if (action === "approve") {
    app.status = "approved";
    app.note = "";
    if (app.role === "player") ensureProfile(app);
  } else if (action === "reject") {
    app.status = "rejected";
    app.note = clean(b.note, 200);
  } else if (action === "suspend") {
    app.status = "suspended";
    rdb.profiles.forEach(function (p) { if (p.userId === app.userId) p.active = false; });
  } else if (action === "restore") {
    app.status = "approved";
  } else {
    throw httpError(404, "Not found.");
  }
  app.reviewed = Date.now();
  saveRdb();
  sendJson(res, 200, { ok: true });
}

async function handleRecruit(req, res, url) {
  if (req.method === "POST" && !sameOrigin(req)) throw httpError(403, "Blocked request.");
  const user = requireUser(currentUser(req));
  const route = req.method + " " + url.pathname;

  switch (route) {
    case "GET /recruit/me": return recruitMe(res, user);
    case "POST /recruit/apply": return recruitApply(req, res, user);
    case "POST /recruit/profile": return saveProfile(req, res, user);
    case "GET /recruit/players": return searchPlayers(url, res, user);
    case "GET /recruit/player": return viewPlayer(url, res, user);
    case "POST /recruit/board": return boardToggle(req, res, user);
    case "GET /recruit/board": return boardList(res, user);
    case "POST /recruit/start": return startThread(req, res, user);
    case "GET /recruit/threads": return listThreads(res, user);
    case "GET /recruit/thread": return getThread(url, res, user);
    case "POST /recruit/send": return sendMessage(req, res, user);
    case "POST /recruit/block": return blockThread(req, res, user);
    case "POST /recruit/report": return reportThread(req, res, user);
    case "POST /recruit/delete-my-data": return deleteMyRecruiting(req, res, user);
    case "GET /recruit/admin/overview":
      requireAdmin(user);
      return adminRecruit(res);
  }
  if (req.method === "POST" && url.pathname.indexOf("/recruit/admin/") === 0) {
    requireAdmin(user);
    return adminRecruitAction(req, res, url.pathname.slice("/recruit/admin/".length));
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

    // Recruiting (locked area)
    if (pathname.startsWith("/recruit/")) {
      await handleRecruit(req, res, url);
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
      "/recruiting": "recruiting.html", "/recruiting.html": "recruiting.html",
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
  console.log("Recruiting at http://localhost:" + PORT + "/recruiting");
  if (ADMIN_USERS.length === 0) console.log("Tip: set ADMIN_USERS=yourusername to use /admin");
});
