// Photostrip Generator web server.
// It does three things: checks the password, serves the app's files, and
// tells the app which paper size to use. Photos never leave your phone's
// browser; the PDF is made right on the phone.

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const PAPER_SIZE = (process.env.PAPER_SIZE || 'letter').toLowerCase() === 'a4' ? 'a4' : 'letter';

if (!PASSWORD) {
  console.error('APP_PASSWORD is not set. Set it in docker-compose.yml (or CasaOS settings) and restart.');
  process.exit(1);
}

// Sessions are signed with a key derived from the password, so changing the
// password logs everyone out.
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('photostrip:' + PASSWORD).digest();
const COOKIE = 'ps_session';
const SESSION_DAYS = 30;

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function makeSession() {
  const expires = String(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  return expires + '.' + sign(expires);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isValidSession(token) {
  if (!token) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig) return false;
  if (!safeEqual(sig, sign(expires))) return false;
  return Number(expires) > Date.now();
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Slow down password guessing: 10 wrong tries per 15 minutes per address.
const failures = new Map();
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function tooManyFailures(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > FAIL_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= FAIL_LIMIT;
}

function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > FAIL_WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/login', (req, res) => {
  if (isValidSession(readCookie(req, COOKIE))) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
  const ip = req.ip;
  if (tooManyFailures(ip)) return res.redirect('/login?error=wait');
  if (!safeEqual((req.body && req.body.password) || '', PASSWORD)) {
    recordFailure(ip);
    return res.redirect('/login?error=wrong');
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', `${COOKIE}=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/login');
});

// Everything below here needs a login.
app.use((req, res, next) => {
  if (isValidSession(readCookie(req, COOKIE))) return next();
  if (req.method === 'GET' && (req.path === '/' || req.accepts(['html', 'json']) === 'html')) return res.redirect('/login');
  res.status(401).json({ error: 'Not logged in' });
});

app.get('/api/config', (req, res) => res.json({ paperSize: PAPER_SIZE }));

app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'pdf-lib', 'dist')));
for (const font of ['great-vibes', 'playfair-display', 'special-elite', 'montserrat']) {
  app.use('/fonts/' + font, express.static(path.join(__dirname, 'node_modules', '@fontsource', font, 'files')));
}
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Photostrip Generator running on port ${PORT} (paper: ${PAPER_SIZE})`);
});
