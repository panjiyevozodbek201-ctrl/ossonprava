// avtoinstruktor — Telegram Mini App backend
// Zero external dependencies — only Node.js built-ins.
// Run with: node server.js   (default port 3000, set PORT env var to change)

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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ---------- tiny helpers ----------

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(seedDb(), null, 2));
  }
}

function seedDb() {
  // A handful of demo records so the app isn't empty on first run.
  const mk = () => crypto.randomBytes(6).toString('hex');
  const t1 = mk(), t2 = mk(), t3 = mk();
  const tk1 = mk(), tk2 = mk();
  return {
    topics: [
      { id: t1, name: 'Umumiy qoidalar', isSign: false, order: 1 },
      { id: t2, name: 'Ogohlantiruvchi belgilar', isSign: true, order: 2 },
      { id: t3, name: 'Taqiqlovchi belgilar', isSign: true, order: 3 }
    ],
    tickets: [
      { id: tk1, number: 1 },
      { id: tk2, number: 2 }
    ],
    questions: [
      {
        id: mk(), topicId: t1, ticketId: tk1, image: null,
        text: "Haydovchilik guvohnomasi necha yoshdan beriladi (B toifa)?",
        answers: [
          { text: '16 yoshdan', correct: false },
          { text: '18 yoshdan', correct: true },
          { text: '21 yoshdan', correct: false },
          { text: '17 yoshdan', correct: false }
        ],
        explanation: "B toifa transport vositalarini boshqarish huquqi 18 yoshga to'lgandan so'ng beriladi."
      },
      {
        id: mk(), topicId: t2, ticketId: tk1, image: null,
        text: "Rasmda ko'rsatilgan belgi nimani bildiradi?",
        answers: [
          { text: "Temir yo'l kesishmasi (shlagbaumsiz)", correct: true },
          { text: "Pasttekislik", correct: false },
          { text: "Tunnel", correct: false },
          { text: "Ko'prik", correct: false }
        ],
        explanation: "Bu ogohlantiruvchi belgi shlagbaumsiz temir yo'l kesishmasidan oldin o'rnatiladi."
      },
      {
        id: mk(), topicId: t3, ticketId: tk2, image: null,
        text: "Rasmda ko'rsatilgan belgi qanday harakatni taqiqlaydi?",
        answers: [
          { text: 'Kirish taqiqlangan', correct: true },
          { text: 'To\u02bbxtash taqiqlangan', correct: false },
          { text: 'Quvib o\u02bbtish taqiqlangan', correct: false },
          { text: 'Burilish taqiqlangan', correct: false }
        ],
        explanation: "Bu belgi barcha transport vositalarining shu tomondan kirishini taqiqlaydi."
      }
    ]
  };
}

function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

let writeQueue = Promise.resolve();
function writeDb(db) {
  writeQueue = writeQueue.then(() => fs.promises.writeFile(DB_FILE, JSON.stringify(db, null, 2)));
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
      if (size > 15 * 1024 * 1024) { // 15MB cap (covers base64 images)
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

// ---------- admin auth (in-memory tokens) ----------
const sessions = new Map(); // token -> expiry timestamp

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 1000 * 60 * 60 * 12); // 12h
  return token;
}

function isAuthed(req) {
  const header = req.headers['authorization'] || '';
  const token = header.replace('Bearer ', '').trim();
  if (!token || !sessions.has(token)) return false;
  const exp = sessions.get(token);
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function requireAuth(req, res) {
  if (!isAuthed(req)) {
    sendJson(res, 401, { error: 'Avtorizatsiya talab qilinadi' });
    return false;
  }
  return true;
}

// ---------- static file serving ----------
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
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- API ----------
async function handleApi(req, res, pathname, query) {
  const db = readDb();
  const segs = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const resource = segs[0];
  const id = segs[1];

  // ----- auth -----
  if (resource === 'admin' && segs[1] === 'login' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (body && body.password === ADMIN_PASSWORD) {
      return sendJson(res, 200, { token: issueToken() });
    }
    return sendJson(res, 401, { error: "Parol noto'g'ri" });
  }

  // ----- stats (counts, public) -----
  if (resource === 'stats' && req.method === 'GET') {
    return sendJson(res, 200, {
      topics: db.topics.length,
      tickets: db.tickets.length,
      questions: db.questions.length
    });
  }

  // ----- topics -----
  if (resource === 'topics') {
    if (req.method === 'GET') return sendJson(res, 200, db.topics.sort((a, b) => a.order - b.order));
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const topic = { id: crypto.randomBytes(6).toString('hex'), name: body.name, isSign: !!body.isSign, order: db.topics.length + 1 };
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

  // ----- tickets -----
  if (resource === 'tickets') {
    if (req.method === 'GET') return sendJson(res, 200, db.tickets.sort((a, b) => a.number - b.number));
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const nextNum = body.number || (db.tickets.reduce((m, t) => Math.max(m, t.number), 0) + 1);
      const ticket = { id: crypto.randomBytes(6).toString('hex'), number: nextNum };
      db.tickets.push(ticket);
      await writeDb(db);
      return sendJson(res, 201, ticket);
    }
    if (id && req.method === 'PUT') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const t = db.tickets.find(x => x.id === id);
      if (!t) return sendJson(res, 404, { error: 'Topilmadi' });
      Object.assign(t, { number: body.number ?? t.number });
      await writeDb(db);
      return sendJson(res, 200, t);
    }
    if (id && req.method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      db.tickets = db.tickets.filter(x => x.id !== id);
      db.questions.forEach(q => { if (q.ticketId === id) q.ticketId = null; });
      await writeDb(db);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ----- questions -----
  if (resource === 'questions') {
    if (segs[1] === 'random' && req.method === 'GET') {
      let pool = db.questions.slice();
      if (query.get('topicId')) pool = pool.filter(q => q.topicId === query.get('topicId'));
      if (query.get('ticketId')) pool = pool.filter(q => q.ticketId === query.get('ticketId'));
      if (query.get('sign') === '1') {
        const signTopicIds = new Set(db.topics.filter(t => t.isSign).map(t => t.id));
        pool = pool.filter(q => signTopicIds.has(q.topicId));
      }
      const count = Math.min(parseInt(query.get('count') || '20', 10), pool.length);
      // shuffle
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return sendJson(res, 200, pool.slice(0, count));
    }
    if (id && req.method === 'GET') {
      const q = db.questions.find(x => x.id === id);
      if (!q) return sendJson(res, 404, { error: 'Topilmadi' });
      return sendJson(res, 200, q);
    }
    if (req.method === 'GET') {
      let list = db.questions.slice();
      if (query.get('topicId')) list = list.filter(q => q.topicId === query.get('topicId'));
      if (query.get('ticketId')) list = list.filter(q => q.ticketId === query.get('ticketId'));
      return sendJson(res, 200, list);
    }
    if (req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const q = {
        id: crypto.randomBytes(6).toString('hex'),
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

  // ----- image upload (base64 data URL -> file on disk) -----
  if (resource === 'upload' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req).catch(() => null);
    if (!body || !body.dataUrl) return sendJson(res, 400, { error: "Rasm topilmadi" });
    const match = /^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/.exec(body.dataUrl);
    if (!match) return sendJson(res, 400, { error: "Format qo'llab-quvvatlanmaydi" });
    const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
    const fname = crypto.randomBytes(10).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOADS_DIR, fname), Buffer.from(match[3], 'base64'));
    return sendJson(res, 201, { url: '/uploads/' + fname });
  }

  sendJson(res, 404, { error: 'Noma\u02bblum so\u02bbrov' });
}

// ---------- server ----------
ensureDirs();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    });
    return res.end();
  }
  try {
    if (u.pathname.startsWith('/api/')) {
      await handleApi(req, res, u.pathname, u.searchParams);
    } else {
      serveStatic(req, res, u.pathname);
    }
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'Server xatosi' });
  }
});

server.listen(PORT, () => {
  console.log(`avtoinstruktor mini app http://localhost:${PORT}  (admin parol: ${ADMIN_PASSWORD})`);
});
