// Langsom Film content API — runs on the Vultr box behind Caddy at https://api.langsomfilm.no
// Username + password -> signed session token -> save films/bio (+ new images) as a commit to GitHub.
// GitHub access is a repo-scoped deploy key that lives only on the server. No dependencies.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const {
  ADMIN_PASSWORD, SESSION_SECRET,
  ADMIN_USERNAME = 'adrian',
  PORT = '3010',
  REPO_DIR = '/data/repo',
  GIT_REMOTE = 'git@github.com:0xJensMalm/langsomfilm.git',
  GIT_BRANCH = 'main',
  ALLOWED_ORIGINS = 'https://langsomfilm.no,https://www.langsomfilm.no',
} = process.env;
if (!ADMIN_PASSWORD || !SESSION_SECRET) { console.error('ADMIN_PASSWORD and SESSION_SECRET are required'); process.exit(1); }

const ORIGINS = new Set(ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean));
const SESSION_DAYS = 60;
const MAX_BODY = 40 * 1024 * 1024;          // whole save request (several images as data URLs)
const MAX_IMAGE = 12 * 1024 * 1024;         // one decoded image
const GIT_ENV = { ...process.env, GIT_SSH_COMMAND: 'ssh -i /keys/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/data/known_hosts' };

/* ---------- git ---------- */
const git = (...args) => run('git', ['-C', REPO_DIR, ...args], { env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });
async function ensureRepo() {
  try { await fs.access(path.join(REPO_DIR, '.git')); }
  catch {
    await run('git', ['clone', '--depth', '1', '--branch', GIT_BRANCH, GIT_REMOTE, REPO_DIR], { env: GIT_ENV });
  }
  await git('config', 'user.name', 'Langsom Film (nettsiden)');
  await git('config', 'user.email', 'noreply@langsomfilm.no');
}
async function sync() {
  await git('fetch', '--depth', '1', 'origin', GIT_BRANCH);
  await git('reset', '--hard', `origin/${GIT_BRANCH}`);
}

/* ---------- sessions ---------- */
const b64u = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
function makeToken() {
  const body = b64u(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5 }));
  return `${body}.${sign(body)}`;
}
function checkToken(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [body, mac] = t.split('.');
  if (!body || !mac) return false;
  const good = sign(body);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url')).exp > Date.now(); } catch { return false; }
}
const same = (x, y) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(x ?? '')).digest(), crypto.createHash('sha256').update(String(y)).digest());
// username is not case-sensitive (phones like to capitalise the first letter); password is
const loginOk = (u, p) => same(String(u ?? '').trim().toLowerCase(), ADMIN_USERNAME.toLowerCase()) & same(p, ADMIN_PASSWORD);
// slow down guessing: 10 failed attempts per IP per 15 minutes
const fails = new Map();
const clientIp = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function tooMany(ip) {
  const f = fails.get(ip); if (!f) return false;
  if (Date.now() - f.since > 15 * 60e3) { fails.delete(ip); return false; }
  return f.n >= 10;
}
const noteFail = ip => { const f = fails.get(ip) || { n: 0, since: Date.now() }; f.n++; fails.set(ip, f); };

/* ---------- content validation ---------- */
const FILM_FIELDS = ['title', 'director', 'year', 'duration', 'lang', 'lang_en', 'regi', 'manus', 'cast', 'synopsis', 'synopsis_en', 'poster'];
const SITE_FIELDS = ['tagline', 'tagline_en', 'company', 'company_en', 'name', 'portrait', 'about', 'about_en', 'email', 'instagram'];
const str = (v, max = 20000) => (typeof v === 'string' ? v : '').slice(0, max);
const slug = s => String(s || 'bilde').toLowerCase().normalize('NFKD').replace(/[æ]/g, 'ae').replace(/[ø]/g, 'o').replace(/[å]/g, 'a')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bilde';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// existing paths must stay inside assets/; new images arrive as data URLs and are written to assets/uploads/
async function imageRef(v, name) {
  v = str(v, MAX_BODY);
  if (!v) return '';
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (m) {
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE) throw new Error('Et bilde er for stort');
    const file = `assets/uploads/${slug(name)}-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8)}.${EXT[m[1]]}`;
    await fs.mkdir(path.join(REPO_DIR, 'assets/uploads'), { recursive: true });
    await fs.writeFile(path.join(REPO_DIR, file), buf);
    return file;
  }
  if (/^assets\/[A-Za-z0-9._\-/]+$/.test(v) && !v.includes('..')) return v;
  throw new Error('Ugyldig bildeadresse');
}
async function clean(input) {
  if (!input || !Array.isArray(input.films) || typeof input.site !== 'object') throw new Error('Ugyldig innhold');
  const films = [];
  for (const f of input.films.slice(0, 200)) {
    const o = {};
    for (const k of FILM_FIELDS) o[k] = k === 'poster' ? await imageRef(f.poster, `${f.title}-plakat`) : str(f[k]);
    if (!o.title || !o.poster) throw new Error('Hver film trenger tittel og plakat');
    o.stills = [];
    for (const [i, s] of (Array.isArray(f.stills) ? f.stills : []).slice(0, 40).entries()) o.stills.push(await imageRef(s, `${f.title}-still-${i + 1}`));
    films.push(o);
  }
  const site = {};
  for (const k of SITE_FIELDS) site[k] = k === 'portrait' ? await imageRef(input.site.portrait, `${input.site.name}-portrett`) : str(input.site[k]);
  return { films, site };
}

/* ---------- operations (one at a time) ---------- */
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

async function readContent() {
  await sync();
  const rd = f => fs.readFile(path.join(REPO_DIR, 'content', f), 'utf8').then(JSON.parse);
  const [site, f] = await Promise.all([rd('site.json'), rd('films.json')]);
  return { site, films: f.films || [] };
}
async function saveContent(input) {
  await sync();
  const { films, site } = await clean(input);
  const json = o => JSON.stringify(o, null, 2) + '\n';
  await fs.writeFile(path.join(REPO_DIR, 'content/films.json'), json({ films }));
  await fs.writeFile(path.join(REPO_DIR, 'content/site.json'), json(site));
  await git('add', '-A', 'content', 'assets/uploads');
  const { stdout } = await git('status', '--porcelain');
  if (!stdout.trim()) return { changed: false, films, site };
  await git('commit', '-m', 'Oppdater innhold (via nettsiden)');
  await git('push', 'origin', `HEAD:${GIT_BRANCH}`);
  return { changed: true, films, site };
}

/* ---------- http ---------- */
function send(res, status, data, origin) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin && ORIGINS.has(origin)) Object.assign(h, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  });
  res.writeHead(status, h); res.end(data === undefined ? '' : JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('For stor forespørsel'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Ugyldig JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') return send(res, 204, undefined, origin);
    if (url.pathname === '/health') return send(res, 200, { ok: true }, origin);
    if (req.method === 'POST' && url.pathname === '/login') {
      const ip = clientIp(req);
      if (tooMany(ip)) return send(res, 429, { error: 'For mange forsøk. Vent et kvarter og prøv igjen.' }, origin);
      const { username, password } = await readBody(req);
      if (!loginOk(username, password)) { noteFail(ip); return send(res, 401, { error: 'Feil brukernavn eller passord' }, origin); }
      fails.delete(ip);
      return send(res, 200, { token: makeToken() }, origin);
    }
    if (!checkToken(req)) return send(res, 401, { error: 'Logg inn på nytt' }, origin);
    if (req.method === 'GET' && url.pathname === '/content') return send(res, 200, await serial(readContent), origin);
    if (req.method === 'POST' && url.pathname === '/save') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, ...(await serial(() => saveContent(body))) }, origin);
    }
    send(res, 404, { error: 'Ikke funnet' }, origin);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, url.pathname, e.message);
    send(res, e.status || (/Ugyldig|trenger|for stort/i.test(e.message) ? 400 : 500), { error: e.message || 'Noe gikk galt' }, origin);
  }
}).listen(+PORT, async () => {
  try { await ensureRepo(); console.log(`langsomfilm-api on :${PORT}, repo ready`); }
  catch (e) { console.error('repo setup failed:', e.message); }
});
