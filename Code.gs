/**
 * Album z imprezy na Google Drive
 * - konta gości: login + hasło (bez maila), 1 administrator do moderacji
 * - wrzucanie zdjęć/filmów, reakcje, komentarze, pokaz slajdów na TV
 * Skrypt ma dostęp TYLKO do plików, które sam utworzył (uprawnienie drive.file).
 *
 * Widoki:  <URL>            – album
 *          <URL>?view=pokaz – pokaz slajdów na TV/projektor
 */

const CONFIG = {
  EVENT_NAME: 'Nasza impreza',                         // tytuł albumu i nazwa folderu
  SUBTITLE: 'Wrzucaj zdjęcia i filmy, daj serduszko, napisz coś miłego',
  ADMIN_LOGIN: 'admin',              // login administratora
  ADMIN_PASSWORD: 'ZMIEN_MNIE',      // hasło administratora – KONIECZNIE zmień (min. 8 znaków)
  REGISTRATION_CODE: '',             // opcjonalny kod imprezy potrzebny do założenia konta, np. 'ania30'
  MAX_FILE_MB: 2048,                 // limit rozmiaru jednego pliku
  SLIDE_SECONDS: 7,                  // czas slajdu w pokazie
  PUBLIC_URL: '',                    // Twój adres, np. 'https://impreza.twojadomena.pl' – do kodu QR i linków
};

const EMOJI = ['❤️', '😍', '😂', '🔥', '👏'];
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SESSION_DAYS = 30;

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  const view = e && e.parameter && e.parameter.view === 'pokaz' ? 'pokaz' : 'album';
  t.cfg = JSON.stringify({
    view: view,
    event: CONFIG.EVENT_NAME,
    subtitle: CONFIG.SUBTITLE,
    needCode: !!CONFIG.REGISTRATION_CODE,
    slideMs: CONFIG.SLIDE_SECONDS * 1000,
    emoji: EMOJI,
    appUrl: CONFIG.PUBLIC_URL || ScriptApp.getService().getUrl(),
  });
  return t.evaluate()
    .setTitle(CONFIG.EVENT_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ======================= KONTA =======================

function register(login, pass, code) {
  if (CONFIG.REGISTRATION_CODE && String(code || '').trim().toLowerCase() !== String(CONFIG.REGISTRATION_CODE).toLowerCase()) {
    throw new Error('Zły kod imprezy – zapytaj organizatora.');
  }
  const name = normLogin_(login);
  const key = name.toLowerCase();
  if (key === CONFIG.ADMIN_LOGIN.toLowerCase()) throw new Error('Ten login jest zajęty.');
  if (String(pass || '').length < 4) throw new Error('Hasło musi mieć co najmniej 4 znaki.');
  return mutate_(function (d) {
    if (d.u[key]) throw new Error('Login „' + d.u[key].n + '” jest zajęty – wybierz inny albo się zaloguj.');
    const salt = rand_();
    d.u[key] = { n: name, h: hash_(pass, salt), s: salt, t: Date.now() };
    return newSession_(d, key);
  });
}

function login(login, pass) {
  const key = String(login || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key) throw new Error('Podaj login.');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fail:' + key) || 0);
  if (fails >= 8) throw new Error('Za dużo nieudanych prób. Spróbuj za 10 minut.');
  const bad = function () {
    cache.put('fail:' + key, String(fails + 1), 600);
    return new Error('Zły login lub hasło.');
  };

  if (key === CONFIG.ADMIN_LOGIN.toLowerCase()) {
    if (!adminEnabled_()) {
      throw new Error('Konto administratora jest wyłączone: w Code.gs ustaw ADMIN_PASSWORD (min. 8 znaków) i wdróż nową wersję.');
    }
    if (String(pass).trim() !== CONFIG.ADMIN_PASSWORD.trim()) throw bad();
    return mutate_(function (d) {
      d.u[key] = d.u[key] || { n: CONFIG.ADMIN_LOGIN, t: Date.now() };
      d.u[key].admin = true;
      delete d.u[key].b;
      return newSession_(d, key);
    });
  }
  const d0 = readData_(true);
  const u = d0.u[key];
  if (!u || u.admin || hash_(pass, u.s) !== u.h) throw bad();
  if (u.b) throw new Error('Konto zostało zablokowane przez organizatora.');
  cache.remove('fail:' + key);
  return mutate_(function (d) { return newSession_(d, key); });
}

function logout(tok) {
  mutate_(function (d) { delete d.s[String(tok)]; });
  return true;
}

// ======================= WRZUCANIE =======================

/** Tworzy sesję "resumable upload"; przeglądarka wysyła plik prosto do Google w kawałkach. */
function startUpload(tok, meta, origin) {
  const me = auth_(tok);
  const mime = String(meta.mimeType || '');
  if (!/^(image|video)\//.test(mime)) throw new Error('Można wrzucać tylko zdjęcia i filmy.');
  const size = Number(meta.size);
  if (!(size > 0)) throw new Error('Pusty plik.');
  if (size > CONFIG.MAX_FILE_MB * 1024 * 1024) throw new Error('Plik za duży (limit ' + CONFIG.MAX_FILE_MB + ' MB).');
  const res = UrlFetchApp.fetch(UPLOAD + '?uploadType=resumable', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(size),
      Origin: origin,
    },
    payload: JSON.stringify({
      name: clean_(me.name, 40) + ' - ' + (clean_(meta.name, 120) || 'plik'),
      parents: [folderId_()],
      description: 'Od: ' + me.name,
      appProperties: { u: me.key },
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Drive odrzucił plik: ' + res.getContentText().slice(0, 200));
  const h = res.getHeaders();
  return h.Location || h.location;
}

function finishUpload(tok, fileId) {
  auth_(tok);
  const id = fid_(fileId);
  const f = api_('get', API + '/files/' + id + '?fields=parents');
  if (!f.parents || f.parents.indexOf(folderId_()) < 0) throw new Error('Nieprawidłowy plik.');
  api_('post', API + '/files/' + id + '/permissions', { role: 'reader', type: 'anyone' });
  CacheService.getScriptCache().remove('media');
  return id;
}

// ======================= ALBUM =======================

function getState(tok) {
  const data = readData_();
  const me = auth_(tok, data);
  const banned = bannedKeys_(data);
  const items = listMedia_().filter(function (it) { return !banned[it.u]; }).map(function (it) {
    const s = data.f[it.id] || {};
    const r = {};
    let my = null;
    Object.keys(s.r || {}).forEach(function (who) {
      if (banned[who]) return;
      const e = s.r[who];
      r[e] = (r[e] || 0) + 1;
      if (who === me.key) my = e;
    });
    return {
      id: it.id, video: it.video, guest: it.guest, t: it.t, w: it.w, h: it.h,
      r: r, my: my, c: (s.c || []).filter(function (c) { return !banned[c.u]; }).length,
      own: !!it.u && it.u === me.key,
      a: (data.u[it.u] && data.u[it.u].a) || '',
    };
  });
  return { me: { name: me.name, admin: me.admin, a: me.a }, items: items };
}

/** Reakcja (jedna na osobę na zdjęcie). Ta sama emotka drugi raz = cofnięcie. */
function react(tok, fileId, emoji) {
  const me = auth_(tok);
  const id = fid_(fileId);
  if (EMOJI.indexOf(emoji) < 0) throw new Error('Nieznana reakcja.');
  assertMedia_(id);
  return mutate_(function (d) {
    const s = d.f[id] = d.f[id] || {};
    s.r = s.r || {};
    if (s.r[me.key] === emoji) delete s.r[me.key]; else s.r[me.key] = emoji;
    const banned = bannedKeys_(d);
    const r = {};
    Object.keys(s.r).forEach(function (k) { if (!banned[k]) r[s.r[k]] = (r[s.r[k]] || 0) + 1; });
    return { r: r, my: s.r[me.key] || null };
  });
}

function getComments(tok, fileId) {
  const data = readData_();
  const me = auth_(tok, data);
  return publicComments_((data.f[fid_(fileId)] || {}).c || [], me, bannedKeys_(data), data.u);
}

/** Nowy komentarz albo odpowiedź (parentId = id komentarza, na który odpowiadamy). */
function addComment(tok, fileId, text, parentId) {
  const me = auth_(tok);
  const id = fid_(fileId);
  const txt = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!txt) throw new Error('Pusty komentarz.');
  assertMedia_(id);
  return mutate_(function (d) {
    const s = d.f[id] = d.f[id] || {};
    s.c = s.c || [];
    if (s.c.length >= 500) throw new Error('Za dużo komentarzy pod tym zdjęciem.');
    const c = { id: rand_().slice(0, 10), n: me.name, x: txt, t: Date.now(), u: me.key };
    if (parentId) {
      const target = findComment_(s.c, parentId);
      if (!target) throw new Error('Komentarz, na który odpowiadasz, został usunięty.');
      c.p = target.p || cid_(target);   // odpowiedzi tylko jeden poziom w głąb
      c.to = target.n;
    }
    s.c.push(c);
    return publicComments_(s.c, me, bannedKeys_(d), d.u);
  });
}

/** Reakcja na komentarz (jedna na osobę). Ta sama emotka drugi raz = cofnięcie. */
function reactComment(tok, fileId, commentId, emoji) {
  const me = auth_(tok);
  const id = fid_(fileId);
  if (EMOJI.indexOf(emoji) < 0) throw new Error('Nieznana reakcja.');
  return mutate_(function (d) {
    const c = findComment_((d.f[id] || {}).c || [], commentId);
    if (!c) throw new Error('Komentarz został usunięty.');
    c.r = c.r || {};
    if (c.r[me.key] === emoji) delete c.r[me.key]; else c.r[me.key] = emoji;
    return publicComments_(d.f[id].c, me, bannedKeys_(d), d.u);
  });
}

/** Własny komentarz – każdy; dowolny – administrator. Usunięcie komentarza usuwa też odpowiedzi pod nim. */
function deleteComment(tok, fileId, commentId) {
  const me = auth_(tok);
  const id = fid_(fileId);
  return mutate_(function (d) {
    const s = d.f[id] || {};
    const c = findComment_(s.c || [], commentId);
    if (c && (c.u === me.key || me.admin)) {
      const cid = cid_(c);
      s.c = s.c.filter(function (x) { return x !== c && x.p !== cid; });
    }
    return publicComments_(s.c || [], me, bannedKeys_(d), d.u);
  });
}

function cid_(c) { return c.id || String(c.t); }
function findComment_(list, cid) {
  cid = String(cid);
  for (let i = 0; i < list.length; i++) if (cid_(list[i]) === cid) return list[i];
  return null;
}

/** Własne zdjęcie – każdy; dowolne – administrator. Plik trafia do kosza na Dysku. */
function deleteMedia(tok, fileId) {
  const me = auth_(tok);
  const id = fid_(fileId);
  const f = api_('get', API + '/files/' + id + '?fields=parents,appProperties');
  if (!f.parents || f.parents.indexOf(folderId_()) < 0) throw new Error('Nieprawidłowy plik.');
  const owner = f.appProperties && f.appProperties.u;
  if (!me.admin && owner !== me.key) throw new Error('Możesz usuwać tylko swoje zdjęcia.');
  api_('patch', API + '/files/' + id, { trashed: true });
  CacheService.getScriptCache().remove('media');
  return true;
}

// ======================= ZDJĘCIE PROFILOWE =======================

/** Zapisuje zdjęcie profilowe (JPEG już przycięty i zmniejszony w przeglądarce, w base64). */
function setAvatar(tok, b64) {
  const me = auth_(tok);
  const str = String(b64 || '');
  if (!str || str.length > 500000) throw new Error('Zdjęcie jest za duże.');
  const bytes = Utilities.base64Decode(str);
  if (bytes.length < 100 || bytes[0] !== -1 || bytes[1] !== -40) throw new Error('Nieprawidłowy obraz.');
  const id = api_('post', API + '/files?fields=id', {
    name: me.key + '.jpg', mimeType: 'image/jpeg', parents: [avatarFolder_()],
  }).id;
  const res = UrlFetchApp.fetch(UPLOAD + '/' + id + '?uploadType=media', {
    method: 'patch',
    contentType: 'image/jpeg',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: bytes,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Nie udało się zapisać zdjęcia.');
  api_('post', API + '/files/' + id + '/permissions', { role: 'reader', type: 'anyone' });
  let old = '';
  mutate_(function (d) { old = d.u[me.key].a; d.u[me.key].a = id; });
  trash_(old);
  return id;
}

function removeAvatar(tok) {
  clearAvatar_(auth_(tok).key);
  return true;
}

function clearAvatar_(key) {
  let old = '';
  mutate_(function (d) { if (d.u[key]) { old = d.u[key].a; delete d.u[key].a; } });
  trash_(old);
}

/** Zdjęcia profilowe w podfolderze „avatary” – nie mieszają się z albumem. */
function avatarFolder_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('AVA_ID');
  if (!id) {
    id = api_('post', API + '/files?fields=id', {
      name: 'avatary', mimeType: 'application/vnd.google-apps.folder', parents: [folderId_()],
    }).id;
    props.setProperty('AVA_ID', id);
  }
  return id;
}

function trash_(id) {
  if (!id) return;
  try { api_('patch', API + '/files/' + fid_(id), { trashed: true }); } catch (e) { /* już usunięty */ }
}

// ======================= MODERACJA (admin) =======================

function adminClearAvatar(tok, key) {
  requireAdmin_(auth_(tok));
  clearAvatar_(String(key));
  return true;
}


function adminUsers(tok) {
  const data = readData_(true);
  requireAdmin_(auth_(tok, data));
  const files = {}, comments = {};
  listMedia_().forEach(function (m) { files[m.u] = (files[m.u] || 0) + 1; });
  Object.keys(data.f).forEach(function (id) {
    (data.f[id].c || []).forEach(function (c) { comments[c.u] = (comments[c.u] || 0) + 1; });
  });
  return Object.keys(data.u).map(function (k) {
    const u = data.u[k];
    return { key: k, n: u.n, a: u.a || '', t: u.t || 0, b: !!u.b, admin: !!u.admin, files: files[k] || 0, comments: comments[k] || 0 };
  }).sort(function (a, b) { return (b.admin - a.admin) || (b.t - a.t); });
}

/** Blokada: użytkownik zostaje wylogowany, nie zaloguje się, a jego zdjęcia/komentarze/reakcje znikają z albumu. */
function adminSetBan(tok, key, ban) {
  requireAdmin_(auth_(tok));
  return mutate_(function (d) {
    const u = d.u[key];
    if (!u || u.admin) throw new Error('Nie można zablokować tego konta.');
    if (ban) {
      u.b = true;
      Object.keys(d.s).forEach(function (t) { if (d.s[t].u === key) delete d.s[t]; });
    } else delete u.b;
    return true;
  });
}

/** Nadaje nowe hasło (gdy ktoś zapomni). Zwraca je, żeby administrator mógł je przekazać. */
function adminResetPassword(tok, key) {
  requireAdmin_(auth_(tok));
  const pass = Math.random().toString(36).slice(2, 8);
  mutate_(function (d) {
    const u = d.u[key];
    if (!u || u.admin) throw new Error('Nie można zmienić hasła tego konta.');
    u.s = rand_();
    u.h = hash_(pass, u.s);
    Object.keys(d.s).forEach(function (t) { if (d.s[t].u === key) delete d.s[t]; });
  });
  return pass;
}

// ======================= DANE =======================

function auth_(tok, data) {
  const d = data || readData_();
  const s = d.s[String(tok || '')];
  if (!s || s.e < Date.now()) throw new Error('SESJA: Zaloguj się ponownie.');
  const u = d.u[s.u];
  if (!u) throw new Error('SESJA: Konto nie istnieje.');
  if (u.b) throw new Error('SESJA: Konto zostało zablokowane przez organizatora.');
  if (u.admin && !adminEnabled_()) throw new Error('SESJA: Konto administratora jest wyłączone.');
  return { key: s.u, name: u.n, admin: !!u.admin, a: u.a || '' };
}

function requireAdmin_(me) { if (!me.admin) throw new Error('Tylko dla administratora.'); }
function adminEnabled_() { return CONFIG.ADMIN_PASSWORD && CONFIG.ADMIN_PASSWORD !== 'ZMIEN_MNIE' && CONFIG.ADMIN_PASSWORD.length >= 8; }

function newSession_(d, key) {
  const now = Date.now();
  Object.keys(d.s).forEach(function (t) { if (d.s[t].e < now) delete d.s[t]; });
  const tok = rand_() + rand_();
  d.s[tok] = { u: key, e: now + SESSION_DAYS * 864e5 };
  return { tok: tok, name: d.u[key].n, admin: !!d.u[key].admin, a: d.u[key].a || '' };
}

function bannedKeys_(d) {
  const b = {};
  Object.keys(d.u).forEach(function (k) { if (d.u[k].b) b[k] = true; });
  return b;
}

function publicComments_(list, me, banned, users) {
  return list.filter(function (c) { return !banned[c.u]; }).map(function (c) {
    const u = users[c.u];
    const r = {};
    Object.keys(c.r || {}).forEach(function (k) { if (!banned[k]) r[c.r[k]] = (r[c.r[k]] || 0) + 1; });
    return {
      id: cid_(c), p: c.p || '', to: c.to || '',
      n: c.n, x: c.x, t: c.t, a: (u && u.a) || '',
      r: r, my: (c.r && c.r[me.key]) || null,
      del: me.admin || (!!c.u && c.u === me.key),
    };
  });
}

function listMedia_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('media');
  if (hit) return JSON.parse(hit);
  const q = "'" + folderId_() + "' in parents and trashed=false and " +
            "(mimeType contains 'image/' or mimeType contains 'video/')";
  const out = [];
  let page = '';
  do {
    const r = api_('get', API + '/files?pageSize=1000&orderBy=createdTime desc' +
      '&fields=nextPageToken,files(id,mimeType,description,createdTime,appProperties,' +
      'imageMediaMetadata(width,height,rotation),videoMediaMetadata(width,height))' +
      '&q=' + encodeURIComponent(q) + (page ? '&pageToken=' + page : ''));
    (r.files || []).forEach(function (f) {
      const im = f.imageMediaMetadata, vm = f.videoMediaMetadata;
      let w = (im && im.width) || (vm && vm.width) || 0;
      let h = (im && im.height) || (vm && vm.height) || 0;
      if (im && im.rotation % 2 === 1) { const x = w; w = h; h = x; }
      out.push({
        id: f.id,
        video: f.mimeType.indexOf('video/') === 0,
        guest: (f.description || '').replace(/^Od: /, ''),
        t: Date.parse(f.createdTime),
        w: w, h: h,
        u: (f.appProperties && f.appProperties.u) || '',
      });
    });
    page = r.nextPageToken;
  } while (page && out.length < 3000);
  try { cache.put('media', JSON.stringify(out), 20); } catch (err) { /* za duże na cache */ }
  return out;
}

function assertMedia_(id) {
  if (!listMedia_().some(function (m) { return m.id === id; })) {
    CacheService.getScriptCache().remove('media');
    if (!listMedia_().some(function (m) { return m.id === id; })) throw new Error('Nie ma takiego zdjęcia.');
  }
}

/** Konta, sesje, reakcje i komentarze trzymamy w pliku galeria-dane.json w folderze imprezy (plik nie jest udostępniany). */
function dataFileId_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('DATA_ID');
  if (id) return id;
  id = api_('post', API + '/files?fields=id', {
    name: 'galeria-dane.json', mimeType: 'application/json', parents: [folderId_()],
  }).id;
  writeRaw_(id, { f: {}, u: {}, s: {} });
  props.setProperty('DATA_ID', id);
  return id;
}

function readData_(fresh) {
  const cache = CacheService.getScriptCache();
  let d = null;
  if (!fresh) {
    const hit = cache.get('data');
    if (hit) d = JSON.parse(hit);
  }
  if (!d) {
    try { d = api_('get', API + '/files/' + dataFileId_() + '?alt=media'); } catch (e) { d = null; }
    d = d || {};
    try { cache.put('data', JSON.stringify(d), 10); } catch (e) { /* za duże na cache */ }
  }
  d.f = d.f || {}; d.u = d.u || {}; d.s = d.s || {};
  return d;
}

function mutate_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const d = readData_(true);
    const result = fn(d);
    writeRaw_(dataFileId_(), d);
    try { CacheService.getScriptCache().put('data', JSON.stringify(d), 10); } catch (e) { /* */ }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function writeRaw_(id, obj) {
  const res = UrlFetchApp.fetch(UPLOAD + '/' + id + '?uploadType=media', {
    method: 'patch',
    contentType: 'application/json; charset=UTF-8',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(obj),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Nie udało się zapisać: ' + res.getContentText().slice(0, 200));
}

// ======================= POMOCNICZE =======================

function folderId_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('FOLDER_ID');
  if (id) return id;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    id = props.getProperty('FOLDER_ID');
    if (!id) {
      id = api_('post', API + '/files?fields=id', {
        name: CONFIG.EVENT_NAME, mimeType: 'application/vnd.google-apps.folder',
      }).id;
      props.setProperty('FOLDER_ID', id);
    }
    return id;
  } finally {
    lock.releaseLock();
  }
}

function api_(method, url, body) {
  const opt = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (body) { opt.contentType = 'application/json; charset=UTF-8'; opt.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(url, opt);
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Drive API ' + code + ': ' + res.getContentText().slice(0, 200));
  const txt = res.getContentText();
  return txt ? JSON.parse(txt) : {};
}

function hash_(pass, salt) {
  let h = String(salt) + '|' + String(pass);
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}
function rand_() { return Utilities.getUuid().replace(/-/g, ''); }
function normLogin_(s) {
  const n = String(s || '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 30) throw new Error('Login musi mieć od 2 do 30 znaków.');
  if (!/^[\p{L}\p{N} ._-]+$/u.test(n)) throw new Error('Login może zawierać litery, cyfry, spacje oraz . _ -');
  return n;
}
function clean_(s, max) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, max);
}
function fid_(f) { return String(f || '').replace(/[^\w-]/g, ''); }

/** Uruchom raz ręcznie z edytora: sprawdza folder, plik danych i ustawienia administratora. */
function test() {
  Logger.log('Folder imprezy: https://drive.google.com/drive/folders/' + folderId_());
  Logger.log('Plik danych: ' + dataFileId_());
  Logger.log(adminEnabled_() ? 'Administrator: ' + CONFIG.ADMIN_LOGIN + ' – OK'
    : 'UWAGA: ustaw ADMIN_PASSWORD (min. 8 znaków), inaczej konto administratora jest wyłączone.');
}

/** Nowa impreza = nowy folder, czyste konta, reakcje i komentarze. */
function nowaImpreza() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('FOLDER_ID');
  p.deleteProperty('DATA_ID');
  p.deleteProperty('AVA_ID');
  CacheService.getScriptCache().removeAll(['media', 'data']);
  test();
}
