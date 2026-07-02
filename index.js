const OS = require('opensubtitles.com');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const VERSION = '2.0.0';
const ADDON_ID = 'com.jscc.nuvio-forced-english-subtitles';
const ADDON_NAME = 'Nuvio Forced English Subtitles';

// Timestamped logging
const log  = (...a) => console.log(`[${new Date().toTimeString().slice(0,8)}]`, ...a);
const logW = (...a) => console.warn(`[${new Date().toTimeString().slice(0,8)}] ⚠️ `, ...a);
const logE = (...a) => console.error(`[${new Date().toTimeString().slice(0,8)}] ✗`, ...a);

const PORT = process.env.PORT || 7001;
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname;
const USERS_FILE = path.join(CONFIG_DIR, 'users.json');
const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ── Multi-user store ──────────────────────────────────────────────────────────
// users.json: { users: { <token>: { apiKey, username, password, jwtToken, createdAt } } }
// The token is the authentication: it's a 32-hex-char secret embedded in each
// user's personal manifest URL. No token → no service.
let store = { users: {} };

function loadStore() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      store = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (!store.users) store.users = {};
      return;
    }
  } catch (e) { logE('[Store] Could not read users.json:', e.message); }
  store = { users: {} };
}

function saveStore() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function newToken() { return crypto.randomBytes(16).toString('hex'); }

function getUser(token) {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return null;
  return store.users[token] || null;
}

function maskKey(key) {
  return key ? key.slice(0, 6) + '•'.repeat(Math.max(0, Math.min(key.length - 6, 20))) : '';
}

// One-time migration from the single-user v1 config.json
function migrateLegacyConfig() {
  try {
    if (!fs.existsSync(LEGACY_CONFIG_FILE)) return;
    const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8'));
    if (legacy.apiKey && legacy.username) {
      const token = newToken();
      store.users[token] = {
        apiKey: legacy.apiKey,
        username: legacy.username,
        password: legacy.password || '',
        jwtToken: legacy.jwtToken || '',
        createdAt: new Date().toISOString(),
      };
      saveStore();
      fs.renameSync(LEGACY_CONFIG_FILE, LEGACY_CONFIG_FILE + '.migrated');
      logW('─'.repeat(70));
      logW('MIGRATED single-user config to multi-user store.');
      logW('Your NEW personal manifest URL (reinstall in Nuvio with this):');
      logW(`  ${process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`}/u/${token}/manifest.json`);
      logW('The old /manifest.json URL no longer works.');
      logW('─'.repeat(70));
    }
  } catch (e) { logE('[Migrate] Legacy migration failed:', e.message); }
}

loadStore();
migrateLegacyConfig();

// ── OpenSubtitles client (per user) ───────────────────────────────────────────
function getOSClient(user) {
  return new OS({
    apikey: user.apiKey,
    useragent: `NuvioForcedSubs v${VERSION}`,
  });
}

async function ensureLoggedIn(token, user) {
  if (user.jwtToken) return user.jwtToken;
  if (!user.username || !user.password) return null;
  try {
    log(`[Auth] Logging in to OpenSubtitles as "${user.username}"...`);
    const os = getOSClient(user);
    const res = await os.login({ username: user.username, password: user.password });
    if (res?.token) {
      user.jwtToken = res.token;
      saveStore();
      log('[Auth] Login successful, token cached');
      return res.token;
    }
    logE('[Auth] Login returned no token');
  } catch (e) { logE('[Auth] Login error:', e.message); }
  return null;
}

// Validate a set of credentials without saving them
async function validateCredentials(apiKey, username, password) {
  const os = new OS({ apikey: apiKey, useragent: `NuvioForcedSubs v${VERSION}` });
  try {
    await os.subtitles({ imdb_id: '133093', languages: 'en' });
  } catch (e) {
    return { ok: false, error: 'API key rejected by OpenSubtitles — check it at opensubtitles.com/en/consumers' };
  }
  try {
    const res = await os.login({ username, password });
    if (!res?.token) return { ok: false, error: 'Login failed — check your username (not email) and password' };
  } catch (e) {
    return { ok: false, error: 'Login failed — check your username (not email) and password' };
  }
  return { ok: true };
}

// ── Manifest ──────────────────────────────────────────────────────────────────
function buildManifest(baseUrl, token) {
  return {
    id: ADDON_ID,
    version: VERSION,
    name: ADDON_NAME,
    description: 'English forced subtitles (foreign-dialogue only) for Nuvio. Returns exactly one subtitle when a forced track exists, and nothing at all when it does not — so fully-English content plays clean with no subtitles.',
    logo: `${baseUrl}/icon.png`,
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      configurationURL: `${baseUrl}/u/${token}/configure`,
    },
  };
}

// ── Media ID parsing ──────────────────────────────────────────────────────────
// Nuvio can request subtitles with either IMDb-style IDs ("tt0265086" or
// "tt0903747:1:5") or TMDB-style IDs ("tmdb:855" or "tmdb:1396:1:5").
function parseMediaId(rawId) {
  const id = decodeURIComponent(rawId);
  if (id.startsWith('tt')) {
    const [imdbId, season, episode] = id.split(':');
    return { kind: 'imdb', imdbId, season, episode };
  }
  if (id.startsWith('tmdb:')) {
    const parts = id.split(':');
    return { kind: 'tmdb', tmdbId: parts[1], season: parts[2], episode: parts[3] };
  }
  return null;
}

// ── Forced subtitle detection ─────────────────────────────────────────────────
const FORCED_KEYWORDS = [
  'forced', 'foreign', 'forc.', 'foreign.parts', 'foreign_parts',
  'foreignparts', 'forced.subs', 'forced_subs', 'forcedsubs',
];
const EXCLUDE_KEYWORDS = [
  'hearing.impaired', 'hearingimpaired', '.hi.', 'sdh', 'cc.',
  'full.subs', 'complete', 'director', 'commentary',
];

function isForced(result) {
  const attrs = result.attributes || {};
  const releaseName = (attrs.release || attrs.files?.[0]?.file_name || '').toLowerCase();

  if (attrs.foreign_parts_only === true) {
    log(`  ✓ Accepted via metadata flag: "${attrs.release || '(unnamed)'}"`);
    return true;
  }

  const hasForced = FORCED_KEYWORDS.some(k => releaseName.includes(k));
  const hasExclude = EXCLUDE_KEYWORDS.some(k => releaseName.includes(k));

  if (hasForced && !hasExclude) {
    log(`  ✓ Accepted via keyword: "${attrs.release || '(unnamed)'}"`);
    return true;
  }

  log(`  ✗ Rejected: "${attrs.release || '(unnamed)'}" (flag=${attrs.foreign_parts_only}, forced=${hasForced}, exclude=${hasExclude})`);
  return false;
}

async function findForcedSubtitle(token, user, media, baseUrl) {
  const os = getOSClient(user);
  const query = {
    languages: 'en',
    order_by: 'download_count',
    order_direction: 'desc',
  };

  const isSeries = !!(media.season && media.episode);

  if (media.kind === 'imdb') {
    query.imdb_id = media.imdbId.replace('tt', '');
  } else {
    if (isSeries) query.parent_tmdb_id = media.tmdbId;
    else query.tmdb_id = media.tmdbId;
  }

  if (isSeries) {
    query.season_number = media.season;
    query.episode_number = media.episode;
  }

  const data = await os.subtitles(query);
  const results = data.data || [];

  if (results.length === 0) { log(`  No results from OpenSubtitles`); return []; }

  log(`  ${results.length} candidate(s) — checking metadata flag then keywords...`);

  const forcedCandidates = results.filter(r => isForced(r));
  if (forcedCandidates.length === 0) {
    log(`  ✗ No forced subtitle found — suppressing subtitles`);
    return [];
  }

  log(`  ${forcedCandidates.length} candidate(s) passed forced filter — verifying line counts...`);

  for (const candidate of forcedCandidates) {
    const fileId = candidate.attributes?.files?.[0]?.file_id;
    const releaseName = candidate.attributes?.release || 'Forced';
    if (!fileId) { log(`  ✗ No fileId for "${releaseName}" — skipping`); continue; }

    log(`  Checking "${releaseName}" (fileId=${fileId})...`);

    const tempUrl = await getDownloadUrl(token, user, fileId);
    if (!tempUrl) {
      log(`  ✗ Failed to get download URL — skipping`);
      continue;
    }

    const lineCount = await countSubtitleLines(tempUrl);
    if (lineCount === null) {
      log(`  ✗ Could not fetch subtitle to verify line count — skipping`);
      continue;
    }

    if (lineCount > 800) {
      log(`  ✗ Rejected: ${lineCount} lines — exceeds 800 line threshold, trying next candidate...`);
      continue;
    } else if (lineCount > 400) {
      log(`  ⚠️  Warning: ${lineCount} lines — higher than expected but under threshold, proceeding`);
    } else {
      log(`  ✓ Line count looks good (${lineCount} lines)`);
    }

    // Nuvio fetches this URL directly and parses the SRT in-app.
    // The token in the path routes the download through this user's account.
    const subUrl = `${baseUrl}/u/${token}/subs/${fileId}.srt`;
    log(`  ➤ Subtitle URL being returned to Nuvio: ${subUrl}`);

    return [{
      id: `forced-en-${fileId}`,
      url: subUrl,
      lang: 'en',
      name: 'English (Forced)',
      title: `English Forced · ${releaseName}`,
    }];
  }

  log(`  ✗ All forced candidates failed line count check — suppressing subtitles`);
  return [];
}

async function countSubtitleLines(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': `NuvioForcedSubs/${VERSION}` },
    });
    if (!response.ok) {
      log(`  ✗ Subtitle fetch failed: HTTP ${response.status}`);
      return null;
    }
    const text = await response.text();
    const sizeKb = (text.length / 1024).toFixed(1);
    log(`  Subtitle file fetched OK (${sizeKb} KB)`);
    const lines = text.split('\n').filter(l => {
      const trimmed = l.trim();
      if (!trimmed) return false;                 // blank
      if (/^\d+$/.test(trimmed)) return false;    // sequence number
      if (/-->/.test(trimmed)) return false;      // timestamp
      return true;                                // actual subtitle text
    });
    return lines.length;
  } catch (e) {
    log(`  Warning: could not fetch subtitle for line count: ${e.message}`);
    return null;
  }
}

async function getDownloadUrl(token, user, fileId) {
  const jwt = await ensureLoggedIn(token, user);
  const os = getOSClient(user);

  try {
    const opts = { file_id: fileId };
    if (jwt) opts.token = jwt;

    const res = await os.download(opts);
    if (res?.link) {
      log(`[Download] OK — remaining quota for "${user.username}": ${res.remaining ?? '?'}`);
      return res.link;
    }
    logE('[Download] No link in response:', JSON.stringify(res));
    return null;
  } catch (e) {
    if (e.message?.includes('401') || e.message?.includes('token')) {
      log('[Auth] Token expired, refreshing...');
      user.jwtToken = '';
      saveStore();
      const newJwt = await ensureLoggedIn(token, user);
      if (!newJwt) return null;
      try {
        const retry = await os.download({ file_id: fileId, token: newJwt });
        if (retry?.link) {
          log(`[Download] Retry OK — remaining quota: ${retry.remaining ?? '?'}`);
          return retry.link;
        }
      } catch (e2) { logE('[Download] Retry failed:', e2.message); }
    } else {
      logE('[Download] Error:', e.message);
    }
    return null;
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
// Collapse duplicate slashes (e.g. //u/<token>/manifest.json from a
// trailing-slash PUBLIC_URL or client-side URL joining) so routes still match
app.use((req, res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});
app.use(require('cors')());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function publicUrl(req) {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/+$/, '');
}

const APP_DIR = __dirname;
app.use('/favicon.ico', (req, res) => res.sendFile(path.join(APP_DIR, 'favicon.ico')));
app.use('/favicon.png', (req, res) => res.sendFile(path.join(APP_DIR, 'favicon.png')));
app.use('/icon.png',    (req, res) => res.sendFile(path.join(APP_DIR, 'icon.png')));
app.use('/icon.svg',    (req, res) => res.sendFile(path.join(APP_DIR, 'icon.svg')));

// Token-auth middleware: resolves req.addonUser or 404s.
// 404 (not 401/403) so probing reveals nothing about valid paths.
function requireUser(req, res, next) {
  const user = getUser(req.params.token);
  if (!user) return res.status(404).send('Not found');
  req.addonUser = user;
  req.addonToken = req.params.token;
  next();
}

// ── Per-user addon endpoints ──────────────────────────────────────────────────
app.get('/u/:token/manifest.json', requireUser, (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(buildManifest(publicUrl(req), req.addonToken));
});

// Matches:
//   /u/<token>/subtitles/movie/tt0265086.json
//   /u/<token>/subtitles/series/tt0903747:1:5.json
//   /u/<token>/subtitles/movie/tmdb:855.json
//   /u/<token>/subtitles/movie/tt0265086/videoHash=abc.json (extra args — ignored)
app.get(/^\/u\/([a-f0-9]{32})\/subtitles\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/, async (req, res) => {
  const token = req.params[0];
  const type = req.params[1];
  const rawId = req.params[2];
  const user = getUser(token);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!user) return res.status(404).send('Not found');

  log(`[Request] user=${user.username} type=${type} id=${rawId}`);

  if (!user.apiKey || !user.username || !user.password) {
    log('  User not fully configured — returning empty');
    return res.json({ subtitles: [] });
  }

  const media = parseMediaId(rawId);
  if (!media) {
    log(`  Unrecognised id format "${rawId}" — returning empty`);
    return res.json({ subtitles: [] });
  }

  try {
    const subtitles = await findForcedSubtitle(token, user, media, publicUrl(req));
    log(`[Result] ${subtitles.length} subtitle(s) for ${rawId}`);
    res.json({ subtitles });
  } catch (err) {
    logE(`[Error] ${err.message}`);
    res.json({ subtitles: [] });
  }
});

// Subtitle proxy — Nuvio's player downloads this URL directly and parses the
// SRT itself, so serve clean UTF-8 SRT with permissive CORS.
async function serveSubtitle(req, res) {
  const fileId = req.params.fileId;
  const user = req.addonUser;
  log(`[Proxy] Nuvio requested subtitle fileId=${fileId} (user=${user.username})`);

  try {
    log(`[Proxy] Fetching fresh download URL from OpenSubtitles...`);
    const downloadUrl = await getDownloadUrl(req.addonToken, user, fileId);
    if (!downloadUrl) {
      log(`[Proxy] ✗ Could not get download URL — check credentials and quota`);
      return res.status(404).send('Could not get download URL');
    }
    log(`[Proxy] Download URL obtained — fetching subtitle file...`);

    const subResponse = await fetch(downloadUrl, {
      headers: {
        'User-Agent': `NuvioForcedSubs/${VERSION}`,
        'Accept-Encoding': 'identity',
      },
    });

    if (!subResponse.ok) {
      log(`[Proxy] ✗ Subtitle file fetch failed: HTTP ${subResponse.status}`);
      return res.status(502).send('Could not fetch subtitle file');
    }

    let subText = await subResponse.text();
    // Strip UTF-8 BOM and normalise line endings for Nuvio's SRT parser
    subText = subText.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    log(`[Proxy] ✓ Subtitle received (${(subText.length/1024).toFixed(1)} KB) — serving SRT`);

    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Length', Buffer.byteLength(subText, 'utf8'));
    res.send(subText);

    log(`[Proxy] ✓ SRT delivered for fileId=${fileId}`);
  } catch (e) {
    logE(`[Proxy] ✗ Error: ${e.message}`);
    res.status(500).send('Proxy error');
  }
}
app.get('/u/:token/subs/:fileId.srt', requireUser, serveSubtitle);
app.get('/u/:token/subs/:fileId', requireUser, serveSubtitle);

// ── Public pages ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(landingPage(publicUrl(req), null));
});

// Create a new user
app.post('/configure', async (req, res) => {
  const apiKey = (req.body.apiKey || '').trim();
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (!apiKey || !username || !password) {
    return res.send(landingPage(publicUrl(req), 'All three fields are required.'));
  }

  const check = await validateCredentials(apiKey, username, password);
  if (!check.ok) {
    log(`[Signup] Rejected credentials for "${username}": ${check.error}`);
    return res.send(landingPage(publicUrl(req), check.error));
  }

  const token = newToken();
  store.users[token] = { apiKey, username, password, jwtToken: '', createdAt: new Date().toISOString() };
  saveStore();
  log(`[Signup] New user "${username}" created (token ${token.slice(0, 6)}…)`);
  res.redirect(`/u/${token}/configure?created=1`);
});

// ── Per-user configure pages ──────────────────────────────────────────────────
app.get('/u/:token/configure', requireUser, (req, res) => {
  res.send(configurePage(publicUrl(req), req.addonToken, req.addonUser, req.query));
});

app.post('/u/:token/configure', requireUser, async (req, res) => {
  const user = req.addonUser;
  const apiKey = (req.body.apiKey || '').trim();
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  const candidate = {
    apiKey: apiKey || user.apiKey,
    username: username || user.username,
    password: password || user.password,
  };
  const check = await validateCredentials(candidate.apiKey, candidate.username, candidate.password);
  if (!check.ok) {
    return res.redirect(`/u/${req.addonToken}/configure?error=${encodeURIComponent(check.error)}`);
  }

  Object.assign(user, candidate, { jwtToken: '' });
  saveStore();
  log(`[Config] Credentials updated for "${user.username}"`);
  res.redirect(`/u/${req.addonToken}/configure?saved=1`);
});

// Regenerate token (invalidates old URL — e.g. after an accidental leak)
app.post('/u/:token/regenerate', requireUser, (req, res) => {
  const user = req.addonUser;
  const fresh = newToken();
  store.users[fresh] = user;
  delete store.users[req.addonToken];
  saveStore();
  log(`[Config] Token regenerated for "${user.username}"`);
  res.redirect(`/u/${fresh}/configure?regenerated=1`);
});

app.get('/u/:token/api/test-key', requireUser, async (req, res) => {
  const user = req.addonUser;
  const check = await validateCredentials(user.apiKey, user.username, user.password);
  res.json(check);
});

// ── Admin (optional, enabled by ADMIN_PASSWORD env var) ───────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(404).send('Not found');
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (pass === ADMIN_PASSWORD) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  res.status(401).send('Authentication required');
}

app.get('/admin', requireAdmin, (req, res) => {
  res.send(adminPage(publicUrl(req)));
});

app.post('/admin/delete', requireAdmin, (req, res) => {
  const token = (req.body.token || '').trim();
  if (store.users[token]) {
    const name = store.users[token].username;
    delete store.users[token];
    saveStore();
    log(`[Admin] Deleted user "${name}"`);
  }
  res.redirect('/admin');
});

app.listen(PORT, () => {
  log(`\n✅ ${ADDON_NAME} v${VERSION} starting...`);
  log(`   Web UI:   http://127.0.0.1:${PORT}/`);
  log(`   Users:    ${Object.keys(store.users).length} configured`);
  log(`   Admin:    ${ADMIN_PASSWORD ? `http://127.0.0.1:${PORT}/admin` : 'disabled (set ADMIN_PASSWORD to enable)'}\n`);
});

// ── HTML Pages ────────────────────────────────────────────────────────────────
const SHARED_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #06080f; --surface: #0e1220; --surface2: #171d30; --border: #252d47;
    --accent: #0877f9; --accent2: #38bdf8; --green: #34d399; --amber: #fbbf24;
    --red: #f87171; --text: #e8ecf5; --muted: #6b7690; --radius: 12px;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Syne', sans-serif; min-height: 100vh; overflow-x: hidden; }
  body::before { content: ''; position: fixed; inset: 0;
    background: radial-gradient(ellipse 60% 40% at 20% 10%, rgba(8,119,249,0.14) 0%, transparent 60%),
                radial-gradient(ellipse 40% 30% at 80% 80%, rgba(56,189,248,0.08) 0%, transparent 60%);
    pointer-events: none; z-index: 0; }
  .container { position: relative; z-index: 1; max-width: 680px; margin: 0 auto; padding: 48px 24px 80px; }
  .logo { display: flex; align-items: center; gap: 14px; margin-bottom: 48px; }
  .logo-icon { width: 48px; height: 48px; background: linear-gradient(135deg, var(--accent), var(--accent2));
    border-radius: 14px; display: flex; align-items: center; justify-content: center;
    font-size: 22px; box-shadow: 0 0 32px rgba(8,119,249,0.4); flex-shrink: 0; }
  .logo-name { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
  .logo-sub  { font-size: 12px; color: var(--muted); margin-top: 3px; font-family: 'DM Mono', monospace; }
  h1 { font-size: 36px; font-weight: 800; letter-spacing: -1.5px; line-height: 1.1; margin-bottom: 12px; }
  h1 span { background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .subtitle { color: var(--muted); font-size: 15px; line-height: 1.6; margin-bottom: 40px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px; margin-bottom: 20px; }
  .card-title { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted); margin-bottom: 18px; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 22px; border-radius: 10px;
    font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; cursor: pointer; border: none;
    transition: all 0.15s ease; text-decoration: none; white-space: nowrap; }
  .btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; box-shadow: 0 4px 20px rgba(8,119,249,0.35); }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(8,119,249,0.5); }
  .btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
  .btn-outline:hover { background: var(--surface2); border-color: var(--accent); }
  .btn-ghost { background: var(--surface2); color: var(--muted); font-size: 13px; }
  .btn-ghost:hover { color: var(--text); }
  .btn-danger { background: transparent; color: var(--red); border: 1px solid rgba(248,113,113,0.35); }
  .btn-danger:hover { background: rgba(248,113,113,0.1); }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot-green { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot-amber { background: var(--amber); box-shadow: 0 0 8px var(--amber); }
  input[type="text"], input[type="password"] { width: 100%; background: var(--bg); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 16px; color: var(--text); font-family: 'DM Mono', monospace;
    font-size: 13px; outline: none; transition: border-color 0.15s; }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(8,119,249,0.15); }
  .form-group { margin-bottom: 22px; }
  .form-label { display: block; font-size: 12px; font-weight: 700; letter-spacing: 1px;
    text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
  .input-row { display: flex; gap: 10px; }
  .input-row input { flex: 1; }
  .alert { padding: 14px 18px; border-radius: 10px; font-size: 13px; margin-bottom: 24px; }
  .alert-success { background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.3); color: var(--green); }
  .alert-error   { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: var(--red); }
  .alert-warn    { background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.3); color: var(--amber); }
  .url-row { display: flex; align-items: center; gap: 10px; }
  .url-box { flex: 1; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; font-family: 'DM Mono', monospace; font-size: 12px; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--surface2);
    border: 1px solid var(--green); color: var(--green); padding: 12px 18px; border-radius: 10px;
    font-size: 13px; font-weight: 600; opacity: 0; transform: translateY(10px);
    transition: all 0.2s ease; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; transform: translateY(0); }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .card { animation: fadeIn 0.4s ease both; }
`;

const TOAST_SCRIPT = `<div class="toast" id="toast"></div><script>
  function showToast(msg) {
    const t = document.getElementById('toast'); t.textContent = '✓ ' + msg;
    t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2500);
  }
</script>`;

function credentialFields(required) {
  return `
    <div class="form-group">
      <label class="form-label" for="apiKey">API Key</label>
      <div class="input-row">
        <input type="password" id="apiKey" name="apiKey" placeholder="Your consumer API key..." autocomplete="off" ${required ? 'required' : ''}/>
        <button type="button" class="btn btn-ghost" onclick="const i=document.getElementById('apiKey');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'Show':'Hide'">Show</button>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="username">Username</label>
      <input type="text" id="username" name="username" placeholder="Your OpenSubtitles.com username (not email)" autocomplete="off" ${required ? 'required' : ''}/>
    </div>
    <div class="form-group">
      <label class="form-label" for="password">Password</label>
      <div class="input-row">
        <input type="password" id="password" name="password" placeholder="Your OpenSubtitles.com password" autocomplete="off" ${required ? 'required' : ''}/>
        <button type="button" class="btn btn-ghost" onclick="const i=document.getElementById('password');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'Show':'Hide'">Show</button>
      </div>
    </div>`;
}

function landingPage(baseUrl, error) {
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" href="/favicon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ADDON_NAME}</title>
  <style>${SHARED_STYLES}
    .step { display: flex; gap: 14px; margin-bottom: 18px; }
    .step:last-child { margin-bottom: 0; }
    .step-num { width: 26px; height: 26px; border-radius: 8px; background: var(--surface2);
      border: 1px solid var(--border); color: var(--accent2); font-weight: 800; font-size: 13px;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
    .step-text { font-size: 14px; color: var(--text); line-height: 1.6; }
    .step-text small { display: block; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  </style></head><body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">💬</div>
      <div class="logo-text">
        <div class="logo-name">${ADDON_NAME}</div>
        <div class="logo-sub">Nuvio Addon · v${VERSION}</div>
      </div>
    </div>
    <h1>Subtitles <span>only when<br>you need them</span></h1>
    <p class="subtitle">Automatically finds English forced subtitles for foreign dialogue.<br>Stays silent when there's nothing to translate.</p>
    ${error ? `<div class="alert alert-error">✗ ${error}</div>` : ''}
    <div class="card">
      <div class="card-title">Get your personal addon URL</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6">
        Enter your own <a href="https://www.opensubtitles.com" target="_blank" style="color:var(--accent2)">OpenSubtitles.com</a> credentials.
        You'll get a private manifest URL tied to your account and your download quota.
        Get a free API key at <a href="https://www.opensubtitles.com/en/consumers" target="_blank" style="color:var(--accent2)">opensubtitles.com/en/consumers</a>.
      </p>
      <form method="POST" action="/configure">
        ${credentialFields(true)}
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">🔑 Create my addon URL</button>
      </form>
      <p style="font-size:12px;color:var(--muted);margin-top:14px;line-height:1.6">
        Credentials are validated with OpenSubtitles before your URL is created.
      </p>
    </div>
    <div class="card">
      <div class="card-title">How it works</div>
      <div class="step"><div class="step-num">1</div><div class="step-text">You get a private manifest URL containing a secret token<small>Anyone without the exact URL gets nothing — no lookups, no subtitle proxy, no credential access.</small></div></div>
      <div class="step"><div class="step-num">2</div><div class="step-text">Install it in Nuvio → Settings → Addons</div></div>
      <div class="step"><div class="step-num">3</div><div class="step-text">When a title has an English forced subtitle, it loads automatically<small>When it doesn't, you get no subtitles — by design.</small></div></div>
    </div>
  </div>
  ${TOAST_SCRIPT}</body></html>`;
}

function configurePage(baseUrl, token, user, query) {
  const manifestUrl = `${baseUrl}/u/${token}/manifest.json`;
  let banner = '';
  if (query.created) banner = '<div class="alert alert-success">✓ Account created and credentials verified. Your private manifest URL is below — install it in Nuvio.</div>';
  else if (query.saved) banner = '<div class="alert alert-success">✓ Credentials updated and verified.</div>';
  else if (query.regenerated) banner = '<div class="alert alert-warn">⚠️ Token regenerated. Your old URL is dead — reinstall the addon in Nuvio using the new manifest URL below.</div>';
  else if (query.error) banner = `<div class="alert alert-error">✗ ${String(query.error)}</div>`;

  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Addon — ${ADDON_NAME}</title>
  <style>${SHARED_STYLES}
    .setting { font-family: 'DM Mono', monospace; font-size: 12.5px; color: var(--accent2); }
    .current { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
      background: var(--bg); border: 1px solid var(--green); border-radius: 10px; margin-bottom: 20px; }
    .current-label { font-size: 12px; color: var(--muted); }
    .current-val { font-family: 'DM Mono', monospace; font-size: 13px; color: var(--green); }
    .divider { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
    .test-result { margin-top: 14px; padding: 12px 16px; border-radius: 8px; font-size: 13px; display: none; }
    .test-ok   { background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.3); color: var(--green); }
    .test-fail { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: var(--red); }
    ul.tips { margin: 0 0 0 18px; font-size: 13.5px; color: var(--muted); line-height: 1.9; }
    ul.tips strong { color: var(--text); }
  </style></head><body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">💬</div>
      <div class="logo-text">
        <div class="logo-name">Your Addon</div>
        <div class="logo-sub">${ADDON_NAME} · v${VERSION} · ${user.username}</div>
      </div>
    </div>
    ${banner}
    <div class="card">
      <div class="card-title">Your private manifest URL</div>
      <div class="url-row">
        <div class="url-box">${manifestUrl}</div>
        <button class="btn btn-ghost" onclick="navigator.clipboard.writeText('${manifestUrl}').then(()=>showToast('URL copied!'))">Copy</button>
      </div>
      <p style="font-size:12.5px;color:var(--amber);margin-top:14px;line-height:1.6">
        ⚠️ Treat this URL like a password — it's tied to your OpenSubtitles account and quota.
        Bookmark this page; the URL is the only way back to it.
      </p>
    </div>
    <div class="card">
      <div class="card-title">Recommended Nuvio settings</div>
      <ul class="tips">
        <li>Settings → Addons → add the manifest URL above</li>
        <li>Subtitle and Audio → <span class="setting">Preferred Language → English</span></li>
        <li>Subtitle and Audio → <span class="setting">Use Forced Subtitles → On</span></li>
        <li>Subtitle and Audio → <span class="setting">Addon Subtitle Startup → Preferred only</span></li>
        <li>Remove or deprioritise the built-in <strong>OpenSubtitles v3</strong> addon</li>
      </ul>
    </div>
    <div class="card">
      <div class="card-title">Update credentials</div>
      <div class="current"><div class="status-dot dot-green"></div>
        <div><div class="current-label">API key</div><div class="current-val">${maskKey(user.apiKey)}</div></div></div>
      <div class="current"><div class="status-dot dot-green"></div>
        <div><div class="current-label">Username</div><div class="current-val">${user.username}</div></div></div>
      <form method="POST" action="/u/${token}/configure">
        ${credentialFields(false)}
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">💾 Save Changes</button>
      </form>
      <p style="font-size:12px;color:var(--muted);margin-top:10px">Leave a field blank to keep its current value.</p>
      <div id="testResult" class="test-result"></div>
      <hr class="divider"/>
      <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="testKey()">🔌 Test my credentials</button>
    </div>
    <div class="card">
      <div class="card-title">Danger zone</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:16px;line-height:1.6">
        If your URL leaks, regenerate the token. The old URL stops working immediately
        and you'll need to reinstall the addon in Nuvio with the new one.
      </p>
      <form method="POST" action="/u/${token}/regenerate" onsubmit="return confirm('Regenerate token? Your current URL will stop working and you must reinstall in Nuvio.')">
        <button type="submit" class="btn btn-danger" style="width:100%;justify-content:center">♻️ Regenerate token</button>
      </form>
    </div>
  </div>
  ${TOAST_SCRIPT}
  <script>
    async function testKey() {
      const res = document.getElementById('testResult');
      res.style.display = 'block'; res.className = 'test-result'; res.textContent = '⏳ Testing...';
      try {
        const r = await fetch('/u/${token}/api/test-key'); const data = await r.json();
        res.className = 'test-result ' + (data.ok ? 'test-ok' : 'test-fail');
        res.textContent = data.ok ? '✓ Credentials are valid and working' : '✗ ' + (data.error || 'Test failed');
      } catch { res.className = 'test-result test-fail'; res.textContent = '✗ Could not reach the test endpoint'; }
    }
  </script></body></html>`;
}

function adminPage(baseUrl) {
  const rows = Object.entries(store.users).map(([token, u]) => `
    <tr>
      <td style="font-family:'DM Mono',monospace;font-size:12px;color:var(--muted)">${token.slice(0, 8)}…</td>
      <td>${u.username}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px;color:var(--muted)">${(u.createdAt || '').slice(0, 10)}</td>
      <td style="text-align:right">
        <form method="POST" action="/admin/delete" style="display:inline" onsubmit="return confirm('Delete user ${u.username}? Their addon URL will stop working.')">
          <input type="hidden" name="token" value="${token}"/>
          <button type="submit" class="btn btn-danger" style="padding:6px 14px;font-size:12px">Delete</button>
        </form>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — ${ADDON_NAME}</title>
  <style>${SHARED_STYLES}
    table { width: 100%; border-collapse: collapse; }
    th { font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
      color: var(--muted); text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
    td { padding: 12px 10px; font-size: 14px; border-bottom: 1px solid var(--border); }
    tr:last-child td { border-bottom: none; }
  </style></head><body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">🛡️</div>
      <div class="logo-text">
        <div class="logo-name">Admin</div>
        <div class="logo-sub">${ADDON_NAME} · v${VERSION}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Users (${Object.keys(store.users).length})</div>
      ${Object.keys(store.users).length === 0
        ? '<p style="font-size:14px;color:var(--muted)">No users yet.</p>'
        : `<table><tr><th>Token</th><th>OpenSubtitles user</th><th>Created</th><th></th></tr>${rows}</table>`}
      <p style="font-size:12px;color:var(--muted);margin-top:16px;line-height:1.6">
        Tokens are shown truncated on purpose — full tokens (and passwords) live only in users.json on the server.
      </p>
    </div>
  </div>
  </body></html>`;
}
// EOF
