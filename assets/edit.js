/* Langsom Film — editing mode. Loaded by index.html only after "Logg inn" (or with a saved login).
   Username + password -> https://api.langsomfilm.no, which commits changes to GitHub; the site
   republishes in about a minute. Images are shrunk in the browser before upload. */
(() => {
// local testing goes through an SSH tunnel to the API on :3010
const API = location.hostname === 'localhost' ? 'http://localhost:3010' : 'https://api.langsomfilm.no';
const RAW = 'https://raw.githubusercontent.com/0xJensMalm/langsomfilm/main/';
const LF = window.LF, $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
let token = null; try { token = localStorage.getItem('lf-token'); } catch (e) {}
let busy = false;

/* freshly uploaded images: show the local copy until the site has republished */
const local = new Map();
window.LF_SRC = p => local.get(p) || (p && p.startsWith('assets/uploads/') ? RAW + p : p);

/* ---------- api ---------- */
async function api(path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error('Fikk ikke kontakt med serveren. Sjekk nettet og prøv igjen.'); });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { forget(); throw new Error('Du er logget ut. Logg inn igjen.'); }
  if (!r.ok) throw new Error(data.error || 'Noe gikk galt (' + r.status + ')');
  return data;
}
const forget = () => { token = null; try { localStorage.removeItem('lf-token'); } catch (e) {} };

/* ---------- toast ---------- */
let tt;
function toast(msg, bad) {
  let el = $('.ed-toast'); if (!el) { el = document.createElement('div'); el.className = 'ed-toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg; el.classList.toggle('bad', !!bad); el.classList.add('on');
  clearTimeout(tt); tt = setTimeout(() => el.classList.remove('on'), bad ? 7000 : 4500);
}

/* ---------- dialogs ---------- */
function dialog(cls, html) {
  const d = document.createElement('dialog'); d.className = 'ed-dlg ' + (cls || ''); d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.querySelectorAll('[data-close]').forEach(b => b.onclick = () => d.close());
  LF.closeSheet(); d.showModal(); return d;
}

/* ---------- login ---------- */
function login() {
  if (token) return enter();
  const d = dialog('login', `<form method="dialog" autocomplete="on">
    <h2>Logg inn</h2><p class="ed-sub">For å redigere filmer og bio.</p>
    <div class="ed-grid">
      <label class="ed-full">Brukernavn<input name="username" autocomplete="username" autocapitalize="none" required></label>
      <label class="ed-full">Passord<input name="password" type="password" autocomplete="current-password" required></label>
    </div>
    <p class="ed-err"></p>
    <div class="ed-actions"><button type="button" class="ed-btn ghost" data-close>Avbryt</button><button class="ed-btn dark">Logg inn</button></div>
  </form>`);
  const f = d.querySelector('form'), err = d.querySelector('.ed-err'), btn = f.querySelector('.dark');
  f.onsubmit = async e => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Logger inn…';
    try {
      const r = await api('/login', { username: f.username.value, password: f.password.value });
      token = r.token; try { localStorage.setItem('lf-token', token); } catch (e) {}
      d.close(); await enter(); toast('Du er logget inn. Trykk «Rediger» under en film, eller «+ Ny film».');
    } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Logg inn'; }
  };
}
async function resume() { if (token) { try { await enter(); } catch (e) { /* stale login: stay a normal visitor */ } } }

/* ---------- edit mode ---------- */
async function enter() {
  const c = await api('/content');          // fresh from GitHub, not the cached site copy
  window.LF_EDITING = true;
  if (!$('.ed-bar')) {
    const bar = document.createElement('div'); bar.className = 'ed-bar';
    bar.innerHTML = `<div class="wrap"><span class="ed-msg"><b>Redigering</b> — endringer vises for alle ca. 1 minutt etter at du lagrer.</span>
      <button class="ed-btn" data-act="add">+ Ny film</button><button class="ed-btn" data-act="bio">Rediger bio</button><button class="ed-btn ghost" data-act="out">Logg ut</button></div>`;
    document.body.prepend(bar);
    bar.onclick = e => { const a = e.target.closest('[data-act]')?.dataset.act; if (a === 'add') editFilm(-1); if (a === 'bio') editBio(); if (a === 'out') { forget(); location.reload(); } };
    addEventListener('lf:render', decorate);
  }
  LF.set(c);
}
function decorate() {
  const films = LF.state.films, track = $('#track');
  track.querySelectorAll('.item').forEach(it => {
    const i = +it.dataset.i;
    it.insertAdjacentHTML('beforeend', `<div class="ed-tools">
      <button data-ed="edit">Rediger</button>
      <button data-ed="left" aria-label="Flytt til venstre" ${i ? '' : 'disabled'}>←</button>
      <button data-ed="right" aria-label="Flytt til høyre" ${i < films.length - 1 ? '' : 'disabled'}>→</button>
      <button data-ed="del" class="ed-del">Slett</button></div>`);
  });
  track.insertAdjacentHTML('beforeend', '<button class="ed-add" data-ed="add"><span>+</span>Legg til film</button>');
  if (!track.dataset.edBound) {
    track.dataset.edBound = 1;
    track.addEventListener('click', e => {
      const b = e.target.closest('button[data-ed]'); if (!b || busy) return;
      e.stopPropagation();
      const i = +(b.closest('.item')?.dataset.i ?? -1), act = b.dataset.ed;
      if (act === 'add') return editFilm(-1);
      if (act === 'edit') return editFilm(i);
      if (act === 'left' || act === 'right') {
        const s = clone(LF.state), j = act === 'left' ? i - 1 : i + 1;
        [s.films[i], s.films[j]] = [s.films[j], s.films[i]];
        return save(s, 'Rekkefølgen er lagret');
      }
      if (act === 'del') {
        if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Sikker?'; setTimeout(() => { if (b.isConnected) { b.classList.remove('armed'); b.textContent = 'Slett'; } }, 3500); return; }
        const s = clone(LF.state), gone = s.films.splice(i, 1)[0];
        return save(s, `«${gone.title}» er slettet`);
      }
    }, true);
  }
}

/* ---------- save everything in one go ---------- */
async function save(next, okMsg) {
  if (busy) return false;
  busy = true; document.body.style.cursor = 'progress';
  try {
    const res = await api('/save', next);
    // remember which uploaded file each local image became, so it keeps showing until republished
    const pair = (a, b) => { if (a && a.startsWith('data:') && b) local.set(b, a); };
    next.films.forEach((f, i) => { const r = res.films[i]; if (!r) return; pair(f.poster, r.poster); (f.stills || []).forEach((s, k) => pair(s, r.stills[k])); });
    pair(next.site.portrait, res.site.portrait);
    LF.set({ site: res.site, films: res.films });
    toast(res.changed ? (okMsg || 'Lagret') + ' — synlig for alle om ca. 1 minutt.' : 'Ingen endringer å lagre.');
    return true;
  } catch (e) { toast(e.message, true); if (!token) setTimeout(login, 400); return false; }
  finally { busy = false; document.body.style.cursor = ''; }
}

/* ---------- images: shrink in the browser ---------- */
function readImg(file, max) {
  return new Promise((ok, fail) => {
    if (!/^image\//.test(file.type)) return fail(new Error('Det der er ikke et bilde.'));
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      let d = c.toDataURL('image/webp', .86); if (!d.startsWith('data:image/webp')) d = c.toDataURL('image/jpeg', .86);
      ok(d);
    };
    im.onerror = () => { URL.revokeObjectURL(url); fail(new Error('Klarte ikke å lese bildet. Prøv JPG eller PNG.')); };
    im.src = url;
  });
}
const thumb = (src, rm) => `<div class="ed-thumb"><img src="${esc(window.LF_SRC(src))}" alt="">${rm != null ? `<button type="button" data-rm="${rm}" aria-label="Fjern bilde">×</button>` : ''}</div>`;

/* ---------- film form ---------- */
const FF = ['title', 'director', 'year', 'duration', 'lang', 'lang_en', 'regi', 'manus', 'cast', 'synopsis', 'synopsis_en'];
function editFilm(i) {
  const draft = i < 0 ? { title: '', poster: '', stills: [] } : clone(LF.state.films[i]);
  draft.stills = draft.stills || [];
  const d = dialog('', `<form method="dialog">
    <h2>${i < 0 ? 'Ny film' : 'Rediger film'}</h2>
    <p class="ed-sub">Bare tittel og plakat er påkrevd. Engelske felt kan stå tomme — da vises norsk tekst.</p>
    <div class="ed-grid">
      <label class="ed-full">Tittel<input name="title" required></label>
      <div class="ed-full"><label>Plakat <span class="ed-hint">— stående, helst 1000 × 1414 px</span></label>
        <div class="ed-thumbs" data-poster></div>
        <label class="ed-pick">Velg plakat…<input type="file" accept="image/*" data-up="poster"></label></div>
      <label>En film av<input name="director"></label>
      <label>År<input name="year" inputmode="numeric"></label>
      <label>Varighet<input name="duration" placeholder="117 min"></label>
      <label>Språk<input name="lang" placeholder="Norsk"></label>
      <label>Regi<input name="regi"></label>
      <label>Manus<input name="manus"></label>
      <label class="ed-full"><span>Medvirkende <span class="ed-hint">— skill navn med komma</span></span><input name="cast"></label>
      <label class="ed-full"><span>Om filmen <span class="ed-hint">— tom linje gir nytt avsnitt</span></span><textarea name="synopsis"></textarea></label>
      <div class="ed-full"><label>Stillbilder <span class="ed-hint">— liggende, gjerne flere</span></label>
        <div class="ed-thumbs" data-stills></div>
        <label class="ed-pick">Legg til bilder…<input type="file" accept="image/*" multiple data-up="stills"></label></div>
      <p class="ed-sec">På engelsk (valgfritt)</p>
      <label class="ed-full">Language<input name="lang_en" placeholder="Norwegian"></label>
      <label class="ed-full">About the film<textarea name="synopsis_en"></textarea></label>
    </div>
    <p class="ed-err"></p>
    <div class="ed-actions"><button type="button" class="ed-btn ghost" data-close>Avbryt</button><button class="ed-btn dark">Lagre</button></div>
  </form>`);
  const f = d.querySelector('form'), err = d.querySelector('.ed-err'), btn = f.querySelector('.dark');
  FF.forEach(k => f[k].value = draft[k] || '');
  const draw = () => {
    d.querySelector('[data-poster]').innerHTML = draft.poster ? thumb(draft.poster) : '';
    d.querySelector('[data-stills]').innerHTML = draft.stills.map((s, k) => thumb(s, k)).join('');
  };
  draw();
  d.querySelector('[data-stills]').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { draft.stills.splice(+b.dataset.rm, 1); draw(); } };
  d.querySelectorAll('[data-up]').forEach(inp => inp.onchange = async () => {
    err.textContent = '';
    try {
      if (inp.dataset.up === 'poster') { if (inp.files[0]) draft.poster = await readImg(inp.files[0], 1500); }
      else for (const file of inp.files) draft.stills.push(await readImg(file, 1800));
      draw();
    } catch (x) { err.textContent = x.message; }
    inp.value = '';
  });
  f.onsubmit = async e => {
    e.preventDefault();
    FF.forEach(k => draft[k] = f[k].value.trim());
    if (!draft.poster) { err.textContent = 'Legg til en plakat før du lagrer.'; return; }
    btn.disabled = true; btn.textContent = 'Lagrer…';
    const s = clone(LF.state); if (i < 0) s.films.push(draft); else s.films[i] = draft;
    if (await save(s, i < 0 ? `«${draft.title}» er lagt til` : 'Filmen er lagret')) d.close();
    else { btn.disabled = false; btn.textContent = 'Lagre'; }
  };
}

/* ---------- bio form ---------- */
const BF = ['tagline', 'tagline_en', 'company', 'company_en', 'name', 'about', 'about_en', 'email', 'instagram'];
function editBio() {
  const draft = clone(LF.state.site);
  const d = dialog('', `<form method="dialog">
    <h2>Rediger bio</h2><p class="ed-sub">Teksten nederst på siden, «Bio»-kortet og kontaktinfo.</p>
    <div class="ed-grid">
      <label class="ed-full">Tekst nederst på siden<input name="tagline"></label>
      <label class="ed-full">Langsom Film — hva vi gjør<textarea name="company"></textarea></label>
      <label>Navn<input name="name"></label>
      <div><label>Portrett <span class="ed-hint">— stående</span></label><div class="ed-thumbs" data-portrait></div>
        <label class="ed-pick">Velg bilde…<input type="file" accept="image/*" data-up></label></div>
      <label class="ed-full">Om meg<textarea name="about"></textarea></label>
      <label>E-post<input name="email" type="email"></label>
      <label>Instagram-lenke<input name="instagram" type="url" placeholder="https://www.instagram.com/…"></label>
      <p class="ed-sec">På engelsk (valgfritt)</p>
      <label class="ed-full">Bottom text<input name="tagline_en"></label>
      <label class="ed-full">What we do<textarea name="company_en"></textarea></label>
      <label class="ed-full">About me<textarea name="about_en"></textarea></label>
    </div>
    <p class="ed-err"></p>
    <div class="ed-actions"><button type="button" class="ed-btn ghost" data-close>Avbryt</button><button class="ed-btn dark">Lagre</button></div>
  </form>`);
  const f = d.querySelector('form'), err = d.querySelector('.ed-err'), btn = f.querySelector('.dark');
  BF.forEach(k => f[k].value = draft[k] || '');
  const draw = () => d.querySelector('[data-portrait]').innerHTML = draft.portrait ? thumb(draft.portrait) : '';
  draw();
  d.querySelector('[data-up]').onchange = async e => {
    try { if (e.target.files[0]) { draft.portrait = await readImg(e.target.files[0], 900); draw(); } } catch (x) { err.textContent = x.message; }
    e.target.value = '';
  };
  f.onsubmit = async e => {
    e.preventDefault();
    BF.forEach(k => draft[k] = f[k].value.trim());
    btn.disabled = true; btn.textContent = 'Lagrer…';
    const s = clone(LF.state); s.site = draft;
    if (await save(s, 'Bio er lagret')) d.close(); else { btn.disabled = false; btn.textContent = 'Lagre'; }
  };
}

window.LF_EDIT = { login, resume };
})();
