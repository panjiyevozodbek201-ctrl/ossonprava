// avtoinstruktor — Telegram Mini App backend (Production Ready)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

const PORT = process.env.PORT || 3000;
// Real loyihada parolni Environment Variable orqali boshqarish shart
const ADMIN_PASSWORD_HASH = crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD || 'admin123').digest('hex');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ topics: [], tickets: [], questions: [] }, null, 2));
  }
}

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error("DB o'qishda xatolik, zaxira yuklanmoqda", e);
    return { topics: [], tickets: [], questions: [] };
  }
}

// Bir vaqtning o'zida yozish operatsiyalari navbati (Atomic write)
let writeQueue = Promise.resolve();
function writeDb(db) {
  const tempFile = DB_FILE + '.tmp';
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.promises.writeFile(tempFile, JSON.stringify(db, null, 2), 'utf8');
      await fs.promises.rename(tempFile, DB_FILE);
    } catch (e) {
      console.error("DB yozishda xatolik:", e);
    }
  });
  return writeQueue;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { // 10MB limit
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const sessions = new Map();
function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 1000 * 60 * 60 * 24); // 24 soatlik sessiya
  return token;
}

function isAuthed(req) {
  const header = req.headers['authorization'] || '';
  const token = header.replace('Bearer ', '').trim();
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) { sessions.delete(token); return false; }
  return true;
}

function requireAuth(req, res) {
  if (!isAuthed(req)) {
    sendJson(res, 401, { error: 'Avtorizatsiya talab qilinadi' });
    return false;
  }
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/admin') rel = '/admin.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Taqiqlangan'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Sahifa topilmadi');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(req, res, pathname, query) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    });
    return res.end();
  }

  const db = readDb();
  const segs = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const resource = segs[0];
  const id = segs[1];

  if (resource === 'admin' && segs[1] === 'login' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (body && body.password) {
      const inputHash = crypto.createHash('sha256').update(body.password).digest('hex');
      if (inputHash === ADMIN_PASSWORD_HASH) {
        return sendJson(res, 200, { token: issueToken() });
      }
    }
    return sendJson(res, 401, { error: "Parol noto'g'ri" });
  }

  if (resource === 'stats' && req.method === 'GET') {
    return sendJson(res, 200, { topics: db.topics.length, tickets: db.tickets.length, questions: db.questions.length });
  }

  // TOPICS RESOURCE
  if (resource === 'topics') {
    if (req.method === 'GET') return sendJson(res, 200, db.topics.sort((a, b) => a.order - b.order));
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      if(!body.name) return sendJson(res, 400, {error: "Nom kiritish majburiy"});
      const topic = { id: crypto.randomBytes(8).toString('hex'), name: body.name, isSign: !!body.isSign, order: db.topics.length + 1 };
      db.topics.push(topic);
      await writeDb(db);
      return sendJson(res, 201, topic);
    }
    if (id && req.method === 'PUT') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const t = db.topics.find(x => x.id === id);
      if (!t) return sendJson(res, 404, { error: 'Topilmadi' });
      Object.assign(t, { name: body.name ?? t.name, isSign: body.isSign ?? t.isSign, order: body.order ?? t.order });
      await writeDb(db);
      return sendJson(res, 200, t);
    }
    if (id && req.method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      db.topics = db.topics.filter(x => x.id !== id);
      db.questions = db.questions.filter(x => x.topicId !== id);
      await writeDb(db);
      return sendJson(res, 200, { ok: true });
    }
  }

  // TICKETS RESOURCE
  if (resource === 'tickets') {
    if (req.method === 'GET') return sendJson(res, 200, db.tickets.sort((a, b) => a.number - b.number));
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const nextNum = parseInt(body.number, 10) || (db.tickets.reduce((m, t) => Math.max(m, t.number), 0) + 1);
      const ticket = { id: crypto.randomBytes(8).toString('hex'), number: nextNum };
      db.tickets.push(ticket);
      await writeDb(db);
      return sendJson(res, 201, ticket);
    }
    if (id && req.method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      db.tickets = db.tickets.filter(x => x.id !== id);
      db.questions.forEach(q => { if (q.ticketId === id) q.ticketId = null; });
      await writeDb(db);
      return sendJson(res, 200, { ok: true });
    }
  }

  // QUESTIONS RESOURCE
  if (resource === 'questions') {
    if (req.method === 'GET') {
      if (id) {
        const q = db.questions.find(x => x.id === id);
        return q ? sendJson(res, 200, q) : sendJson(res, 404, { error: 'Topilmadi' });
      }
      let list = db.questions.slice();
      if (query.get('topicId')) list = list.filter(q => q.topicId === query.get('topicId'));
      if (query.get('ticketId')) list = list.filter(q => q.ticketId === query.get('ticketId'));
      return sendJson(res, 200, list);
    }
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const q = {
        id: crypto.randomBytes(8).toString('hex'),
        topicId: body.topicId || null,
        ticketId: body.ticketId || null,
        image: body.image || null,
        text: body.text || '',
        answers: Array.isArray(body.answers) ? body.answers : [],
        explanation: body.explanation || ''
      };
      db.questions.push(q);
      await writeDb(db);
      return sendJson(res, 201, q);
    }
    if (id && req.method === 'PUT') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const q = db.questions.find(x => x.id === id);
      if (!q) return sendJson(res, 404, { error: 'Topilmadi' });
      Object.assign(q, {
        topicId: body.topicId ?? q.topicId,
        ticketId: body.ticketId ?? q.ticketId,
        image: body.image === undefined ? q.image : body.image,
        text: body.text ?? q.text,
        answers: body.answers ?? q.answers,
        explanation: body.explanation ?? q.explanation
      });
      await writeDb(db);
      return sendJson(res, 200, q);
    }
    if (id && req.method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      db.questions = db.questions.filter(x => x.id !== id);
      await writeDb(db);
      return sendJson(res, 200, { ok: true });
    }
  }

  // IMAGE UPLOAD RESOURCE (Base64 sanitization & saving)
  if (resource === 'upload' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req).catch(() => null);
    if (!body || !body.dataUrl) return sendJson(res, 400, { error: "Rasm topilmadi" });
    
    const match = body.dataUrl.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
    if (!match) return sendJson(res, 400, { error: "Format noto'g'ri" });
    
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    const fullPath = path.join(UPLOADS_DIR, filename);
    
    await fs.promises.writeFile(fullPath, buffer);
    return sendJson(res, 200, { url: `/uploads/${filename}` });
  }

  return sendJson(res, 404, { error: 'API endpoint topilmadi' });
}

ensureDirs();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url.pathname, url.searchParams).catch(err => {
      console.error(err);
      sendJson(res, 500, { error: 'Ichki server xatoligi' });
    });
  } else {
    serveStatic(req, res, url.pathname);
  }
});

server.listen(PORT, () => console.log(`Server portda ishga tushdi: ${PORT}`));
