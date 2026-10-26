import { Chess } from './chess.js';
import { CLS, ORDER, summarizePosition, buildAnalysis, parseInfo, estimateGameElo, estimatePlayerElo, eloText,
  ELO_MIN_MOVES, ELO_MIN_GAMES, ELO_LAST_GAMES, ELO_GAME_ERR, ELO_AVG_ERR } from './core.js';
import { playerGames } from './sources.js';
import { enabled as sharing, openGroup, newCode, cleanCode } from './partage.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 700;

const OPERA_PGN = `[Event "Paris"]
[Site "Paris FRA"]
[Date "1858.11.02"]
[White "Paul Morphy"]
[Black "Duc de Brunswick et comte Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

const S = {
  view: 'groupe', players: [], games: [], mode: 'loading',
  period: '30', gfilter: 'all', game: null, ply: 0, flip: false,
  depth: MOBILE ? 12 : 15, job: null, flash: null, editPlayer: null, confirm: null, engineErr: null,
  rapidOnly: true, sync: null, limit: 40, group: null, between: false, duel: null,
};

/* ---------- Stockage ---------- */
// - Les parties récupérées restent sur chaque appareil (localStorage) : chacun les récupère lui-même.
// - Les joueurs et les bilans sont partagés dans Firestore quand un groupe est ouvert. Sans
//   configuration Firebase, ils restent aussi dans le navigateur (mode local).
// S.games = parties locales + parties connues seulement par leur bilan, bilan attaché.
const GKEY = 'salle-analyse-groupe';
const SYNC_EVERY = 15 * 60000; // récupération automatique au plus toutes les 15 min
let local = { games: [], players: [], bilans: [], lastSync: 0 };
let bilans = [];
let duels = []; // parties entre deux joueurs du groupe, gardées dans Firestore pour toujours
let remote = null; // fonctions d'écriture Firestore quand un groupe est ouvert

const lkey = () => 'salle-analyse-v3:' + (S.group || 'local');
function loadLocal() { try { local = { games: [], players: [], bilans: [], lastSync: 0, ...JSON.parse(localStorage.getItem(lkey()) || '{}') }; } catch (_) {} }
function saveLocal() {
  try { localStorage.setItem(lkey(), JSON.stringify(local)); }
  catch (_) { S.flash = { t: 'err', m: 'Le stockage du navigateur est plein : certaines parties ne seront pas gardées.' }; }
}
function upsert(arr, o) { const i = arr.findIndex((x) => x.id === o.id); if (i >= 0) arr[i] = o; else arr.push(o); }

function rebuild() {
  const byId = new Map(local.games.map((g) => [g.id, { ...g, analysis: null }]));
  for (const d of duels) if (!byId.has(d.id)) byId.set(d.id, { ...d, analysis: null });
  for (const b of bilans) { const g = byId.get(b.id); if (g) g.analysis = b.analysis; else byId.set(b.id, b); }
  S.games = [...byId.values()];
  if (S.game && !S.game.sample) S.game = S.games.find((x) => x.id === S.game.id) || S.game;
  render();
}

// Groupes connus sur cet appareil : [{ code, name }]. On peut en avoir plusieurs et passer de
// l'un à l'autre ; le dernier ouvert est rouvert à la visite suivante.
const GLIST = 'salle-analyse-groupes';
function myGroups() {
  try {
    const l = JSON.parse(localStorage.getItem(GLIST) || 'null');
    if (l) return l;
    const old = cleanCode(localStorage.getItem(GKEY)); // ancienne version : un seul groupe
    return old ? [{ code: old, name: '' }] : [];
  } catch (_) { return []; }
}
function saveGroups(l) { try { localStorage.setItem(GLIST, JSON.stringify(l)); } catch (_) {} }
function rememberGroup(code, name) {
  const l = myGroups(); const g = l.find((x) => x.code === code);
  if (g) { if (name != null) g.name = name; } else l.push({ code, name: name || '' });
  saveGroups(l);
}
const groupName = (code) => (myGroups().find((x) => x.code === code) || {}).name || code;

async function initStore() {
  if (!sharing) { S.mode = 'local'; loadLocal(); S.players = local.players; bilans = local.bilans; rebuild(); autoSync(); return; }
  let saved = null; try { saved = localStorage.getItem(GKEY); } catch (_) {}
  const code = cleanCode(new URLSearchParams(location.search).get('g')) || cleanCode(saved) || (myGroups()[0] || {}).code;
  if (code) joinGroup(code); else { S.mode = 'nogroup'; render(); }
}

function leaveCurrent() {
  if (remote) remote.close();
  remote = null; S.players = []; bilans = []; duels = []; local = { games: [], players: [], bilans: [], lastSync: 0 };
  S.game = null; S.gfilter = 'all'; S.editPlayer = null; S.confirm = null;
}

async function joinGroup(code, name) {
  if (S.job) { S.flash = { t: 'err', m: 'Un bilan est en cours : attends la fin ou arrête-le avant de changer de groupe.' }; render(); return; }
  leaveCurrent();
  S.group = code; S.mode = 'loading'; S.view = 'groupe'; loadLocal(); rebuild();
  rememberGroup(code, name);
  try { localStorage.setItem(GKEY, code); } catch (_) {}
  history.replaceState(null, '', location.pathname + '?g=' + code);
  let first = true;
  try {
    const r = await openGroup(code, {
      onInfo: (info) => { if (S.group === code && info.name) { rememberGroup(code, info.name); render(); } },
      onPlayers: (ps) => { if (S.group !== code) return; S.players = ps; S.mode = 'shared'; rebuild(); if (first) { first = false; autoSync(); } },
      onBilans: (bs) => { if (S.group !== code) return; bilans = bs; rebuild(); },
      onDuels: (ds) => { if (S.group !== code) return; duels = ds; rebuild(); },
      onError: (e) => { S.flash = { t: 'err', m: 'Le partage ne répond pas (' + (e && (e.code || e.message)) + '). Recharge la page.' }; render(); },
    });
    if (S.group !== code) { r.close(); return; }
    remote = r;
    if (name) r.setName(name).catch(() => {}); // nom choisi à la création du groupe
  } catch (e) {
    S.mode = 'nogroup'; S.flash = { t: 'err', m: 'Impossible de joindre Firebase (' + (e && e.message) + '). Vérifie ta connexion.' }; render();
  }
}

// Retire le groupe de cet appareil seulement : rien n'est effacé pour les autres, et le lien
// permet d'y revenir.
function forgetGroup(code) {
  saveGroups(myGroups().filter((x) => x.code !== code));
  try { localStorage.removeItem('salle-analyse-v3:' + code); if (localStorage.getItem(GKEY) === code) localStorage.removeItem(GKEY); } catch (_) {}
  const next = myGroups()[0];
  if (next) joinGroup(next.code);
  else { leaveCurrent(); S.group = null; S.mode = 'nogroup'; history.replaceState(null, '', location.pathname); render(); }
}

function autoSync() { if (S.players.length && Date.now() - local.lastSync > SYNC_EVERY) syncGames(); }
function writeErr(e) {
  const m = e && e.code === 'permission-denied' ? 'Enregistrement refusé par les règles de sécurité.' : 'Enregistrement impossible (' + (e && (e.code || e.message) || 'erreur') + ').';
  S.flash = { t: 'err', m }; render();
}

async function savePlayer(p) {
  if (remote) return remote.putPlayer(p);
  upsert(local.players, p); S.players = local.players; saveLocal(); rebuild();
}
async function removePlayer(id) {
  if (remote) return remote.delPlayer(id);
  local.players = local.players.filter((x) => x.id !== id); S.players = local.players; saveLocal(); rebuild();
}
// Le bilan emporte la partie avec lui : un ami qui ne l'a pas dans sa liste la voit quand même.
async function saveBilan(g, analysis) {
  const { analysis: _old, sample: _s, ...meta } = g;
  const b = { ...meta, analysis };
  if (remote) return remote.putBilan(b);
  upsert(local.bilans, b); bilans = local.bilans; saveLocal(); rebuild();
}
function addGames(gs) { gs.forEach((g) => upsert(local.games, g)); saveLocal(); rebuild(); }
function removeGame(id) { local.games = local.games.filter((x) => x.id !== id); saveLocal(); rebuild(); }

// Une partie « entre nous » : les deux camps sont des joueurs (différents) du groupe.
function duelSides(g) {
  const w = playerFor(g.white, g.site); const b = playerFor(g.black, g.site);
  return w && b && w.id !== b.id ? { w, b } : null;
}
// Les duels sont rares : on les range dans Firestore pour qu'ils restent au-delà des 3 mois
// gardés sur chaque appareil, et que tout le monde ait le même historique.
async function saveDuels() {
  if (!remote) return;
  const have = new Set(duels.map((d) => d.id));
  for (const g of local.games) {
    if (have.has(g.id) || !duelSides(g)) continue;
    const { analysis: _a, sample: _s, ...meta } = g;
    try { await remote.putDuel(meta); } catch (_) { return; } // règles pas encore publiées : on réessaiera
  }
}

/* ---------- Récupération automatique ---------- */
const IMPORT_MONTHS = 3;
const IMPORT_RAPID = 300; // par joueur et par site : en pratique, toutes ses rapides des 3 mois
const IMPORT_OTHER = 50;  // les autres cadences, pour l'option « Toutes cadences »

// Partie récupérée (format de sources.js) → partie de l'appli (format de l'ancienne version).
function toGame(src) {
  const d = new Date(src.end);
  const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const plies = new Chess();
  try { plies.loadPgn(src.pgn, { strict: false }); } catch (_) { return null; }
  const n = plies.history().length;
  if (!n) return null;
  return {
    id: src.id, pgn: src.pgn, white: src.white, black: src.black, result: src.result,
    date, end: src.end, tc: src.tc, timeClass: src.timeClass, site: src.site, link: src.url,
    wElo: src.wElo ? String(src.wElo) : '', bElo: src.bElo ? String(src.bElo) : '',
    plies: n, first: 'w', siteAcc: src.acc, addedAt: new Date().toISOString(),
  };
}

// Récupère les parties récentes de chaque joueur et ajoute celles qu'on n'a pas encore.
async function syncGames(players = S.players) {
  if (S.sync) return;
  const group = S.group;
  S.sync = { done: 0, total: players.length, errors: [] }; render();
  let added = 0;
  for (const p of players) {
    const { games, errors } = await playerGames({ chesscom: p.chesscom, lichess: p.lichess }, { max: IMPORT_RAPID, maxOther: IMPORT_OTHER, months: IMPORT_MONTHS });
    if (S.group !== group) { S.sync = null; render(); return; } // on a changé de groupe entre-temps
    errors.forEach((e) => S.sync.errors.push(p.name + ' : ' + e.message));
    const known = new Set(local.games.map((g) => g.id));
    const fresh = games.filter((g) => !known.has(g.id)).map(toGame).filter(Boolean);
    if (fresh.length) { addGames(fresh); added += fresh.length; }
    S.sync.done++; render();
  }
  const errs = S.sync.errors;
  S.sync = null;
  local.lastSync = Date.now(); saveLocal();
  saveDuels();
  S.flash = { t: errs.length ? 'err' : 'ok', m: (added ? added + ' nouvelle' + (added > 1 ? 's parties' : ' partie') : 'Aucune nouvelle partie') + '.' + (errs.length ? ' ' + errs.join(' · ') : '') };
  render();
}

/* ---------- PGN ---------- */
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function splitPgns(text) {
  const t = text.replace(/\r/g, '').trim(); if (!t) return [];
  return t.split(/\n(?=\s*\[Event\s)/).map((s) => s.trim()).filter(Boolean);
}
function parsePgn(pgn) {
  const c = new Chess(); c.loadPgn(pgn, { strict: false });
  const h = c.getHeaders(); const hist = c.history({ verbose: true });
  if (!hist.length) throw new Error('aucun coup trouvé');
  const siteStr = (h.Site || '') + ' ' + (h.Link || '');
  const site = /lichess/i.test(siteStr) ? 'lichess' : /chess\.com/i.test(siteStr) ? 'chesscom' : 'autre';
  const date = (h.UTCDate || h.Date || '').replace(/\./g, '-');
  const link = h.Link || (/^https?:/.test(h.Site || '') ? h.Site : '');
  return {
    hist,
    meta: {
      white: h.White || 'Blancs', black: h.Black || 'Noirs', result: h.Result || '*',
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', tc: h.TimeControl || '', site, link,
      wElo: h.WhiteElo || '', bElo: h.BlackElo || '', plies: hist.length, first: hist[0].color,
    },
  };
}
const PARSED = new Map();
function parsed(g) {
  let p = PARSED.get(g.id);
  if (!p) {
    const c = new Chess(); c.loadPgn(g.pgn, { strict: false });
    const hist = c.history({ verbose: true });
    p = { hist, fens: [hist[0].before, ...hist.map((m) => m.after)] };
    PARSED.set(g.id, p);
  }
  return p;
}
function tcLabel(tc) {
  if (!tc || tc === '-') return '';
  const [base, inc] = tc.split('+'); const b = +base;
  if (!b) return tc;
  const min = b >= 60 ? Math.round(b / 60) + ' min' : b + ' s';
  return inc && +inc ? min + ' + ' + inc + ' s' : min;
}
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return '';
  return new Date(y, m - 1, day).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: y === new Date().getFullYear() ? undefined : 'numeric' });
}

/* ---------- Joueurs ---------- */
function playerFor(username, site) {
  const u = String(username || '').toLowerCase(); if (!u) return null;
  return S.players.find((p) => (site !== 'lichess' && (p.chesscom || '').toLowerCase() === u) || (site !== 'chesscom' && (p.lichess || '').toLowerCase() === u))
    || S.players.find((p) => (p.chesscom || '').toLowerCase() === u || (p.lichess || '').toLowerCase() === u) || null;
}
function sideName(g, side) {
  const u = side === 'w' ? g.white : g.black; const p = playerFor(u, g.site);
  return { name: p ? p.name : u, handle: p ? u : '', player: p };
}

/* ---------- Moteur ---------- */
// Profondeurs proposées. Mesuré sur PC le 2026-10-25 (Stockfish 18 lite, une partie de 56
// positions) : 0,3 s par position à 12, 1,3 s à 15, 2,1 s à 16, 3,7 s à 17, de 3 à 8 s à 19.
// Chaque cran de profondeur coûte environ ×1,65.
const DEPTHS = [[12, 'Rapide'], [15, 'Normal'], [17, 'Précis']];
function duration(positions, depth) {
  const s = Math.max(10, Math.round(positions * 0.3 * 1.65 ** (depth - 12)));
  return s < 90 ? s + ' s' : Math.round(s / 60) + ' min';
}
const engine = {
  w: null, ready: null, q: Promise.resolve(),
  init() {
    if (this.ready) return this.ready;
    this.ready = new Promise((res, rej) => {
      let w;
      try { w = new Worker('moteur/stockfish-18-lite-single.js'); } catch (e) { rej(e); return; }
      this.w = w;
      const t = setTimeout(() => rej(new Error('le moteur met trop de temps à démarrer')), 60000);
      w.onerror = () => { clearTimeout(t); rej(new Error('le moteur n’a pas pu se lancer')); };
      w.onmessage = (e) => {
        const l = String(e.data);
        if (l === 'uciok') { w.postMessage('setoption name MultiPV value 2'); w.postMessage('setoption name Hash value 32'); w.postMessage('isready'); }
        else if (l === 'readyok') { clearTimeout(t); w.onmessage = null; res(); }
      };
      w.postMessage('uci');
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  },
  evaluate(fen, depth) {
    const run = () => new Promise((res) => {
      const lines = {};
      this.w.onmessage = (e) => {
        const l = String(e.data);
        const x = parseInfo(l); if (x) { lines[x.mpv] = x.line; return; }
        if (l.startsWith('bestmove')) res({ lines: [lines[1], lines[2]].filter(Boolean), best: l.split(' ')[1] });
      };
      this.w.postMessage('position fen ' + fen);
      this.w.postMessage('go depth ' + depth);
    });
    this.q = this.q.then(run, run);
    return this.q;
  },
};

async function analyze(g) {
  if (S.job) return;
  const p = parsed(g); const n = p.fens.length; const depth = S.depth;
  const job = { id: g.id, done: 0, total: n, cancel: false, phase: 'load' };
  S.job = job; S.engineErr = null; render();
  try { await engine.init(); } catch (e) { S.job = null; S.engineErr = e.message || String(e); render(); return; }
  job.phase = 'run'; updateProgress();
  const t0 = performance.now();
  const pos = [];
  for (let i = 0; i < n; i++) {
    if (job.cancel) break;
    const fen = p.fens[i]; const c = new Chess(fen);
    const res = c.isGameOver() ? null : await engine.evaluate(fen, depth);
    pos.push(summarizePosition(fen, res));
    job.done = i + 1; updateProgress();
  }
  S.job = null;
  if (job.cancel) { render(); return; }
  const analysis = buildAnalysis(p.hist, pos, depth);
  analysis.sec = Math.round((performance.now() - t0) / 1000);
  g.analysis = analysis;
  if (S.game && S.game.id === g.id) S.game = g;
  render();
  if (!g.sample) { try { await saveBilan(g, analysis); S.flash = { t: 'ok', m: S.mode === 'shared' ? 'Bilan enregistré : tout le groupe peut le voir.' : 'Bilan enregistré sur cet appareil.' }; render(); } catch (e) { writeErr(e); } }
}
function updateProgress() {
  const j = S.job; const el = $('#prog'); const tx = $('#progtx'); if (!j || !el) return;
  el.style.width = (j.total ? (100 * j.done) / j.total : 0) + '%';
  if (tx) tx.textContent = j.phase === 'load' ? 'Chargement du moteur (7 Mo, une seule fois)…' : 'Position ' + j.done + ' sur ' + j.total;
}

/* ---------- Statistiques du groupe ---------- */
function inPeriod(g) {
  if (S.period === 'all') return true;
  const t = g.end || (g.date ? new Date(g.date + 'T12:00:00').getTime() : new Date(g.addedAt || 0).getTime());
  return Date.now() - t <= +S.period * 86400000;
}
// Les parties collées à la main n'ont pas de cadence connue : on les garde toujours.
function inCadence(g) { return !S.rapidOnly || !g.timeClass || g.timeClass === 'rapid'; }
// Elo estimé d'un joueur du groupe : moyenne de précision de ses derniers bilans en rapide
// (le calibrage a été fait sur des rapides ; en blitz la précision est plus basse).
function playerElo(p) {
  const accs = [];
  for (const g of S.games) {
    if (!g.analysis || (g.timeClass && g.timeClass !== 'rapid')) continue;
    for (const side of ['w', 'b']) {
      const pl = playerFor(side === 'w' ? g.white : g.black, g.site);
      if (pl && pl.id === p.id && g.analysis.acc[side] != null) accs.push([g.end || Date.parse(g.date) || 0, g.analysis.acc[side]]);
    }
  }
  accs.sort((x, y) => y[0] - x[0]);
  return estimatePlayerElo(accs.map((x) => x[1]));
}
function moverOf(g, i) { const f = g.first || 'w'; return i % 2 === 0 ? f : (f === 'w' ? 'b' : 'w'); }
function groupStats() {
  const games = S.games.filter((g) => inPeriod(g) && inCadence(g));
  const st = new Map(S.players.map((p) => [p.id, { p, games: 0, an: 0, acc: [], blunders: 0, mistakes: 0, brill: 0, great: 0, w: 0, d: 0, l: 0 }]));
  const tops = []; const flops = [];
  for (const g of games) {
    for (const side of ['w', 'b']) {
      const pl = playerFor(side === 'w' ? g.white : g.black, g.site); if (!pl) continue;
      const s = st.get(pl.id); s.games++;
      if (g.result === '1/2-1/2') s.d++; else if ((g.result === '1-0') === (side === 'w') && g.result !== '*') s.w++; else if (g.result !== '*') s.l++;
      const a = g.analysis; if (!a) continue;
      s.an++; if (a.acc[side] != null) s.acc.push(a.acc[side]);
      a.ply.forEach((pl2, i) => {
        if (moverOf(g, i) !== side) return;
        if (pl2.c === 'blunder') { s.blunders++; flops.push({ g, i, loss: pl2.l, who: pl.name }); }
        else if (pl2.c === 'mistake') s.mistakes++;
        else if (pl2.c === 'brilliant') { s.brill++; tops.push({ g, i, rank: 2, who: pl.name }); }
        else if (pl2.c === 'great') { s.great++; tops.push({ g, i, rank: 1, who: pl.name }); }
      });
    }
  }
  const rows = [...st.values()].map((s) => ({ ...s, avg: s.acc.length ? s.acc.reduce((x, y) => x + y, 0) / s.acc.length : null }));
  rows.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.games - a.games);
  tops.sort((a, b) => b.rank - a.rank || (b.g.date || '').localeCompare(a.g.date || ''));
  flops.sort((a, b) => b.loss - a.loss);
  return { rows, tops: tops.slice(0, 6), flops: flops.slice(0, 6), unanalyzed: games.filter((g) => !g.analysis).length, total: games.length };
}
function moveLabel(g, i) {
  const p = parsed(g); const m = p.hist[i]; if (!m) return '';
  const no = Math.floor((i + (g.first === 'b' ? 1 : 0)) / 2) + 1;
  return no + (m.color === 'w' ? '. ' : '… ') + m.san;
}

/* ---------- Rendu ---------- */
function render() {
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-current', t.dataset.view === S.view ? 'page' : 'false'));
  const st = $('#status');
  const groups = myGroups();
  if (S.mode === 'local') st.innerHTML = '<span class="dot warn"></span><span>Mode local : rien n’est partagé</span>';
  else if (!groups.length) st.innerHTML = `<span class="dot"></span><span>${S.mode === 'nogroup' ? 'Pas encore de groupe' : 'Connexion au groupe…'}</span>`;
  else {
    // Sélecteur de groupe : passer d'un groupe à l'autre, ou en rejoindre / créer un nouveau.
    const cur = S.mode === 'nogroup' ? '__new' : S.group;
    const opts = groups.map((g) => `<option value="${esc(g.code)}" ${g.code === cur ? 'selected' : ''}>${esc(g.name || g.code)}</option>`).join('')
      + `<option value="__new" ${cur === '__new' ? 'selected' : ''}>+ Rejoindre ou créer un groupe</option>`;
    st.innerHTML = `<span class="dot ${S.mode === 'shared' ? 'on' : ''}"></span><select id="gsel" class="gsel" aria-label="Groupe">${opts}</select>`;
  }
  $('#tabs').hidden = S.mode === 'nogroup';
  const main = $('#main');
  const flash = S.flash ? `<div class="note ${S.flash.t}" role="status" style="margin-bottom:14px">${esc(S.flash.m)}</div>` : '';
  let html = '';
  if (S.mode === 'nogroup') html = viewWelcome();
  else if (S.mode === 'loading') html = '<div class="panel empty"><p>Connexion au groupe…</p></div>';
  else if (S.view === 'groupe') html = viewGroup();
  else if (S.view === 'parties') html = viewGames();
  else if (S.view === 'joueurs') html = viewPlayers();
  else if (S.view === 'duel') html = viewDuel();
  else html = viewAnalysis();
  const ta = $('#pgn'); const keep = ta ? ta.value : null;
  main.innerHTML = flash + html;
  if (keep != null && $('#pgn')) $('#pgn').value = keep;
  updateProgress();
  const cur = main.querySelector('.mv[aria-current="true"]'); const box = main.querySelector('.moves');
  if (cur && box) { const top = cur.offsetTop - box.offsetTop; if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) box.scrollTop = top - box.clientHeight / 2; }
}

const groupLink = () => location.origin + location.pathname + '?g=' + S.group;
async function copyLink() {
  try { await navigator.clipboard.writeText(groupLink()); S.flash = { t: 'ok', m: 'Lien copié : envoie-le au groupe.' }; }
  catch (_) { S.flash = { t: 'err', m: 'Copie impossible : sélectionne le lien à la main.' }; }
  render();
}

// Filtres partagés entre les pages Parties et Groupe : changer l'un change les deux.
function periodSeg() {
  return `<div class="seg" role="group" aria-label="Période">${[['7', '7 jours'], ['30', '30 jours'], ['all', 'Depuis le début']].map(([v, l]) => `<button data-act="period" data-v="${v}" aria-pressed="${S.period === v}">${l}</button>`).join('')}</div>`;
}
function betweenSeg() {
  return `<div class="seg" role="group" aria-label="Adversaires">${[[false, 'Toutes'], [true, 'Entre nous']].map(([v, l]) => `<button data-act="between" data-v="${v}" aria-pressed="${S.between === v}">${l}</button>`).join('')}</div>`;
}
function cadenceSeg() {
  return `<div class="seg" role="group" aria-label="Cadence">${[[true, 'Rapides'], [false, 'Toutes cadences']].map(([v, l]) => `<button data-act="cadence" data-v="${v}" aria-pressed="${S.rapidOnly === v}">${l}</button>`).join('')}</div>`;
}

function viewWelcome() {
  const groups = myGroups();
  const mine = groups.length ? `<div class="panel" style="margin-bottom:16px"><div class="eyebrow" style="margin-bottom:6px">Mes groupes</div>
    ${groups.map((g) => `<button class="hl-item" data-act="opengroup" data-v="${esc(g.code)}"><span><div class="big">${esc(g.name || 'Groupe sans nom')}</div><div class="sub mono">${esc(g.code)}</div></span><span class="right">Ouvrir</span></button>`).join('')}</div>` : '';
  return `${mine}<div class="grid2">
    <div class="panel stack">
      <div><div class="eyebrow">Tu as reçu un code</div><h2 class="h2" style="margin-top:4px">Rejoindre un groupe</h2></div>
      <label class="f">Code du groupe<input type="text" id="gcode" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7Q2X-M9PTA"></label>
      <div><button class="btn primary" data-act="joingroup">Rejoindre</button></div>
      <p class="muted small" style="margin:0">Le plus simple : ouvre le lien que tes amis t’ont envoyé, le code est dedans.</p>
    </div>
    <div class="panel stack">
      <div><div class="eyebrow">Premier du groupe</div><h2 class="h2" style="margin-top:4px">Créer un groupe</h2></div>
      <label class="f">Nom du groupe<input type="text" id="gname" maxlength="40" autocomplete="off" placeholder="Les rapides du jeudi"></label>
      <p class="muted small" style="margin:0">L’appli tire un code au hasard. Tu envoies ensuite le lien à tes amis : toute personne qui a le lien voit et complète les bilans du groupe, sans créer de compte.</p>
      <div><button class="btn" data-act="newgroup">Créer le groupe</button></div>
    </div>
  </div>`;
}

function viewGroup() {
  const seg = `<div class="row">${cadenceSeg()}${periodSeg()}</div>`;
  if (!S.players.length && !S.games.length) {
    return `<div class="panel empty">
      <div class="eyebrow">Pour commencer</div>
      <h2>Ajoutez les joueurs du groupe</h2>
      <p>Chacun entre son pseudo chess.com ou Lichess. L’appli récupère ensuite ses parties toute seule ; vous lancez le bilan : il est calculé sur votre appareil, sans limite par jour.</p>
      <div class="row" style="justify-content:center">
        <button class="btn primary" data-act="go" data-v="joueurs">Ajouter un joueur</button>
        <button class="btn" data-act="sample">Essayer sur la partie de l’Opéra (1858)</button>
      </div>
    </div>`;
  }
  const s = groupStats();
  const table = s.rows.length ? `<div class="tablewrap"><table class="ranking">
    <thead><tr><th></th><th>Joueur</th><th class="num">Parties</th><th class="num">Précision moy.</th><th class="num" title="Sur les ${ELO_LAST_GAMES} derniers bilans en rapide (${ELO_MIN_GAMES} minimum), à ± ${ELO_AVG_ERR} près">Elo estimé</th><th class="num">Gaffes / partie</th><th class="num">Brillants</th><th class="num">V · N · D</th></tr></thead>
    <tbody>${s.rows.map((r, i) => `<tr>
      <td class="rank">${r.avg != null ? i + 1 : '–'}</td>
      <td class="pl"><div class="who">${esc(r.p.name)}</div><div class="handle">${esc([r.p.chesscom && 'chess.com ' + r.p.chesscom, r.p.lichess && 'lichess ' + r.p.lichess].filter(Boolean).join(' · '))}</div></td>
      <td class="num st-games" data-l="Parties">${r.games}${r.an < r.games ? `<span class="muted"> (${r.an} bilan${r.an > 1 ? 's' : ''})</span>` : ''}</td>
      <td class="num st-acc" data-l="Précision">${r.avg != null ? r.avg.toFixed(1) + ' %<span class="accbar"><i style="width:' + r.avg + '%"></i></span>' : '<span class="muted">—</span>'}</td>
      <td class="num st-elo" data-l="Elo estimé">${(() => { const e = playerElo(r.p); return e ? eloText(e) : `<span class="muted" title="Il faut ${ELO_MIN_GAMES} bilans en rapide">—</span>`; })()}</td>
      <td class="num st-bl" data-l="Gaffes / partie">${r.an ? (r.blunders / r.an).toFixed(1) : '—'}</td>
      <td class="num st-br" data-l="Brillants">${r.brill}</td>
      <td class="num st-wdl" data-l="V · N · D">${r.w} · ${r.d} · ${r.l}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">Aucun joueur enregistré. <button class="btn ghost" data-act="go" data-v="joueurs">Ajouter un joueur</button></p>`;
  const item = (x, kind) => {
    const opp = sideName(x.g, moverOf(x.g, x.i) === 'w' ? 'b' : 'w').name;
    const cls = kind === 'top' ? x.g.analysis.ply[x.i].c : 'blunder';
    return `<button class="hl-item" data-act="open" data-id="${esc(x.g.id)}" data-ply="${x.i + 1}">
      <span class="b b-${cls}">${CLS[cls].sym}</span>
      <span><div class="big">${esc(moveLabel(x.g, x.i))}</div><div class="sub">${esc(x.who)} contre ${esc(opp)}${x.g.date ? ' · ' + fmtDate(x.g.date) : ''}</div></span>
      <span class="right">${kind === 'top' ? CLS[cls].label : '−' + Math.round(x.loss) + ' %'}</span></button>`;
  };
  const note = s.unanalyzed ? `<div class="note">${s.unanalyzed} partie${s.unanalyzed > 1 ? 's' : ''} sans bilan sur cette période : elle${s.unanalyzed > 1 ? 's ne comptent' : ' ne compte'} pas encore dans la précision. <button class="btn ghost" data-act="go" data-v="parties">Voir les parties</button></div>` : '';
  return `<div class="stack">
    <div class="row" style="justify-content:space-between"><h2 class="h2">Classement du groupe</h2>${seg}</div>
    <div class="panel">${table}</div>
    ${note}
    <div class="grid2">
      <div class="panel"><div class="eyebrow" style="margin-bottom:6px">Meilleurs coups</div>
        ${s.tops.length ? `<div class="hl-list">${s.tops.map((x) => item(x, 'top')).join('')}</div>` : '<p class="muted small">Pas encore de coup brillant ou de grand coup sur cette période.</p>'}</div>
      <div class="panel"><div class="eyebrow" style="margin-bottom:6px">Pires gaffes</div>
        ${s.flops.length ? `<div class="hl-list">${s.flops.map((x) => item(x, 'flop')).join('')}</div>` : '<p class="muted small">Aucune gaffe enregistrée sur cette période. Ça ne durera pas.</p>'}</div>
    </div>
    ${crossTable()}
    <p class="muted small">La précision et les classements imitent la méthode de chess.com (perte de probabilité de gain à chaque coup), mais ne donnent pas exactement les mêmes chiffres. L’Elo estimé vient de la précision moyenne des ${ELO_LAST_GAMES} derniers bilans en rapide (${ELO_MIN_GAMES} minimum), calée sur 2 900 parties chess.com : compte ± ${ELO_AVG_ERR} points.</p>
  </div>`;
}

/* ---------- Duels : parties entre joueurs du groupe ---------- */
// Résultat d'une partie du point de vue d'un joueur : 'w', 'd' ou 'l' (null si non terminée).
function outcome(g, sideOfPlayer) {
  if (g.result === '1/2-1/2') return 'd';
  if (g.result !== '1-0' && g.result !== '0-1') return null;
  return (g.result === '1-0') === (sideOfPlayer === 'w') ? 'w' : 'l';
}
// Duels entre a et b (ids), du plus récent au plus ancien, avec le camp de a.
function duelGames(a, b, games = S.games) {
  const out = [];
  for (const g of games) {
    const d = duelSides(g); if (!d) continue;
    if (d.w.id === a && d.b.id === b) out.push({ g, side: 'w' });
    else if (d.w.id === b && d.b.id === a) out.push({ g, side: 'b' });
  }
  return out.sort((x, y) => (y.g.end || 0) - (x.g.end || 0) || (y.g.date || '').localeCompare(x.g.date || ''));
}
function score(list) {
  const s = { w: 0, d: 0, l: 0 };
  for (const { g, side } of list) { const o = outcome(g, side); if (o) s[o]++; }
  return s;
}
const challengeUrl = (p) => 'https://www.chess.com/play/online/new?opponent=' + encodeURIComponent(p.chesscom);
const challengeBtn = (p, label) => (p.chesscom ? `<a class="btn" href="${esc(challengeUrl(p))}" target="_blank" rel="noopener">${esc(label || 'Défier ' + p.name)} ↗</a>` : '');

// Tableau croisé : la case (ligne A, colonne B) donne les victoires · nulles · défaites de A contre B,
// sur la période et la cadence choisies.
function crossTable() {
  if (S.players.length < 2) return '';
  const games = S.games.filter((g) => inPeriod(g) && inCadence(g) && duelSides(g));
  const ps = S.players.slice().sort((a, b) => a.name.localeCompare(b.name));
  const head = ps.map((p) => `<th class="cx-h" title="${esc(p.name)}">${esc(p.name)}</th>`).join('');
  const rows = ps.map((a) => `<tr><th class="cx-r">${esc(a.name)}</th>${ps.map((b) => {
    if (a.id === b.id) return '<td class="cx-self"></td>';
    const s = score(duelGames(a.id, b.id, games)); const n = s.w + s.d + s.l;
    const tone = !n ? '' : s.w > s.l ? 'cx-up' : s.w < s.l ? 'cx-down' : 'cx-even';
    return `<td><button class="cx ${tone}" data-act="duel" data-a="${esc(a.id)}" data-b="${esc(b.id)}" aria-label="${esc(a.name)} contre ${esc(b.name)}">${n ? `${s.w}·${s.d}·${s.l}` : '–'}</button></td>`;
  }).join('')}</tr>`).join('');
  return `<div class="panel stack">
    <div class="row" style="justify-content:space-between"><div><div class="eyebrow">Entre nous</div><h2 class="h2" style="margin-top:4px">Qui a battu qui</h2></div>
      <span class="small muted">${games.length} partie${games.length > 1 ? 's' : ''} entre vous sur cette période</span></div>
    <div class="tablewrap"><table class="cross"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small" style="margin:0">Chaque case : victoires · nulles · défaites du joueur de la ligne contre celui de la colonne. Clique sur une case pour la fiche du duel.</p>
  </div>`;
}

function viewDuel() {
  const A = S.players.find((p) => p.id === S.duel?.a); const B = S.players.find((p) => p.id === S.duel?.b);
  if (!A || !B) return `<div class="panel empty"><p>Ce duel n’existe plus.</p><button class="btn" data-act="go" data-v="groupe">← Groupe</button></div>`;
  const list = duelGames(A.id, B.id);
  const s = score(list);
  // Série en cours : victoires consécutives du même joueur en partant de la plus récente.
  let streak = 0, who = null;
  for (const { g, side } of list) {
    const o = outcome(g, side); if (!o || o === 'd') break;
    const winner = o === 'w' ? A : B;
    if (who && who !== winner) break;
    who = winner; streak++;
  }
  // Précision moyenne de chacun et moments forts, sur les duels qui ont un bilan.
  const acc = { a: [], b: [] }; let top = null, flop = null;
  for (const { g, side } of list) {
    const an = g.analysis; if (!an) continue;
    const other = side === 'w' ? 'b' : 'w';
    if (an.acc[side] != null) acc.a.push(an.acc[side]);
    if (an.acc[other] != null) acc.b.push(an.acc[other]);
    an.ply.forEach((x, i) => {
      const mover = moverOf(g, i); const name = (mover === side ? A : B).name;
      const rank = x.c === 'brilliant' ? 2 : x.c === 'great' ? 1 : 0;
      if (rank && (!top || rank > top.rank)) top = { g, i, rank, name, c: x.c };
      if (x.c === 'blunder' && (!flop || x.l > flop.loss)) flop = { g, i, loss: x.l, name };
    });
  }
  const mean = (xs) => (xs.length ? (xs.reduce((p, q) => p + q, 0) / xs.length).toFixed(1) + ' %' : '—');
  const moment = (x, kind) => (x ? `<button class="hl-item" data-act="open" data-id="${esc(x.g.id)}" data-ply="${x.i + 1}">
      <span class="b b-${kind === 'top' ? x.c : 'blunder'}">${CLS[kind === 'top' ? x.c : 'blunder'].sym}</span>
      <span><div class="big">${esc(moveLabel(x.g, x.i))}</div><div class="sub">${esc(x.name)}${x.g.date ? ' · ' + fmtDate(x.g.date) : ''}</div></span>
      <span class="right">${kind === 'top' ? CLS[x.c].label : '−' + Math.round(x.loss) + ' %'}</span></button>` : `<p class="muted small" style="margin:0">${kind === 'top' ? 'Pas encore de brillant ni de grand coup' : 'Pas encore de gaffe'} dans vos duels analysés.</p>`);
  const analysed = list.filter((x) => x.g.analysis).length;
  const games = list.map(({ g, side }) => {
    const o = outcome(g, side);
    return `<div class="game"><div style="min-width:0">
        <div class="vs"><span class="res-dot ${o || ''}">${{ w: 'V', l: 'D', d: '½' }[o] || '?'}</span> ${esc(A.name)} (${side === 'w' ? 'Blancs' : 'Noirs'})</div>
        <div class="meta">${[fmtDate(g.date), tcLabel(g.tc), g.analysis ? `précision ${g.analysis.acc[side] ?? '–'} % contre ${g.analysis.acc[side === 'w' ? 'b' : 'w'] ?? '–'} %` : 'pas encore de bilan'].filter(Boolean).map(esc).join(' · ')}</div></div>
      <div class="row"><button class="btn ${g.analysis ? '' : 'primary'}" data-act="open" data-id="${esc(g.id)}" data-ply="0">${g.analysis ? 'Voir le bilan' : 'Faire le bilan'}</button></div></div>`;
  }).join('');
  return `<div class="row" style="margin-bottom:12px;justify-content:space-between"><button class="btn ghost" data-act="go" data-v="groupe">← Groupe</button>
      <button class="btn ghost" data-act="duel" data-a="${esc(B.id)}" data-b="${esc(A.id)}">Inverser ⇄</button></div>
    <div class="stack">
      <div class="panel stack">
        <div class="eyebrow">Fiche duel</div>
        <div class="duel-head"><div class="duel-name">${esc(A.name)}</div><div class="duel-score mono">${s.w} · ${s.d} · ${s.l}</div><div class="duel-name right">${esc(B.name)}</div></div>
        <p class="muted small" style="margin:0;text-align:center">victoires · nulles · défaites de ${esc(A.name)}, ${list.length} partie${list.length > 1 ? 's' : ''} en tout${streak >= 2 ? ` · <strong>${esc(who.name)} a gagné les ${streak} dernières</strong>` : ''}</p>
        <div class="row" style="justify-content:center">${challengeBtn(B, 'Défier ' + B.name + ' sur chess.com')}${challengeBtn(A, 'Défier ' + A.name + ' sur chess.com')}</div>
        ${!A.chesscom || !B.chesscom ? '<p class="muted small" style="margin:0;text-align:center">Le bouton Défier a besoin du pseudo chess.com du joueur (onglet Joueurs).</p>' : ''}
      </div>
      <div class="grid2">
        <div class="panel stack"><div class="eyebrow">Précision moyenne dans vos duels</div>
          <div class="acc-duo"><div class="acc-card"><div class="p">${esc(A.name)}</div><div class="n mono">${mean(acc.a)}</div></div><div class="acc-card"><div class="p">${esc(B.name)}</div><div class="n mono">${mean(acc.b)}</div></div></div>
          <p class="muted small" style="margin:0">Sur ${analysed} duel${analysed > 1 ? 's' : ''} avec bilan.</p></div>
        <div class="panel stack"><div class="eyebrow">Moments forts</div>
          <div class="hl-list">${moment(top, 'top')}${moment(flop, 'flop')}</div></div>
      </div>
      <div class="panel"><h2 class="h2" style="margin-bottom:6px">Leurs parties</h2>${games || '<p class="muted">Pas encore de partie entre vous. Le bouton Défier est là pour ça.</p>'}</div>
    </div>`;
}

function viewGames() {
  const opts = ['<option value="all">Tous les joueurs</option>', ...S.players.map((p) => `<option value="${esc(p.id)}" ${S.gfilter === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)].join('');
  let games = S.games.filter((g) => inCadence(g) && inPeriod(g));
  if (S.gfilter !== 'all') games = games.filter((g) => [g.white, g.black].some((u) => { const p = playerFor(u, g.site); return p && p.id === S.gfilter; }));
  if (S.between) games = games.filter(duelSides);
  games.sort((a, b) => (b.end || 0) - (a.end || 0) || (b.date || '').localeCompare(a.date || '') || (b.addedAt || '').localeCompare(a.addedAt || ''));
  const total = games.length; games = games.slice(0, S.limit);
  const list = games.length ? games.map((g) => {
    const W = sideName(g, 'w'); const B = sideName(g, 'b'); const a = g.analysis;
    const src = g.site === 'lichess' ? 'Lichess' : g.site === 'chesscom' ? 'chess.com' : 'PGN';
    const conf = S.confirm === 'g:' + g.id;
    return `<div class="game">
      <div style="min-width:0">
        <div class="vs">${esc(W.name)}${g.wElo ? ' <span class="muted small">(' + esc(g.wElo) + ')</span>' : ''} <span class="muted">–</span> ${esc(B.name)}${g.bElo ? ' <span class="muted small">(' + esc(g.bElo) + ')</span>' : ''} <span class="mono muted small">${esc(g.result)}</span></div>
        <div class="meta">${[fmtDate(g.date), tcLabel(g.tc), src, Math.ceil(g.plies / 2) + ' coups'].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="row" style="margin-top:6px;gap:6px">${duelSides(g) ? '<span class="chip duel">Entre nous</span>' : ''}${a ? `<span class="chip acc">Blancs ${a.acc.w ?? '–'} %</span><span class="chip acc">Noirs ${a.acc.b ?? '–'} %</span>` : '<span class="chip">Pas encore de bilan</span>'}</div>
      </div>
      <div class="row">
        <button class="btn ${a ? '' : 'primary'}" data-act="open" data-id="${esc(g.id)}" data-ply="0">${a ? 'Voir le bilan' : 'Faire le bilan'}</button>
        ${g.timeClass ? '' : conf ? `<button class="btn danger" data-act="delgame" data-id="${esc(g.id)}">Confirmer la suppression</button><button class="btn ghost" data-act="unconfirm">Annuler</button>`
               : `<button class="btn ghost" data-act="confirm" data-v="g:${esc(g.id)}" aria-label="Supprimer la partie">Supprimer</button>`}
      </div></div>`;
  }).join('') : `<p class="muted">${S.between && S.games.length ? 'Aucune partie entre vous sur ce filtre. Défiez-vous depuis l’onglet Groupe !' : S.games.length ? 'Aucune partie pour ce filtre.' : S.players.length ? 'Aucune partie pour l’instant : lance la récupération ci-dessus.' : 'Ajoute d’abord les joueurs du groupe, leurs parties arriveront toutes seules.'}</p>`;
  const more = total > games.length ? `<div class="row" style="justify-content:center;margin-top:10px"><button class="btn" data-act="more">Afficher plus (${total - games.length} restantes)</button></div>` : '';
  const sync = S.sync
    ? `<div class="prog"><i style="width:${(100 * S.sync.done) / (S.sync.total || 1)}%"></i></div><span class="small muted">Récupération : joueur ${Math.min(S.sync.done + 1, S.sync.total)} sur ${S.sync.total}…</span>`
    : `<div class="row"><button class="btn primary" data-act="sync" ${S.players.length ? '' : 'disabled'}>Récupérer les nouvelles parties</button><button class="btn ghost" data-act="sample">Essayer sur la partie de l’Opéra</button></div>`;
  return `<div class="stack">
    <div class="panel stack">
      <div><h2 class="h2">Parties récentes</h2><p class="muted small" style="margin:4px 0 0">L’appli va chercher les parties des ${IMPORT_MONTHS} derniers mois de chaque joueur sur chess.com et Lichess.</p></div>
      ${sync}
      <details><summary>Coller un PGN à la main</summary>
        <div class="stack" style="margin-top:10px">
          <textarea id="pgn" spellcheck="false" placeholder='[Event "Live Chess"]&#10;[White "pseudo1"]&#10;[Black "pseudo2"]&#10;…&#10;1. e4 e5 2. Nf3 …'></textarea>
          <div class="row"><button class="btn" data-act="addpgn">Ajouter</button></div>
        </div>
      </details>
    </div>
    <div class="panel">
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><h2 class="h2">Parties du groupe</h2>
        <div class="row">${betweenSeg()}${cadenceSeg()}${periodSeg()}<label class="f" style="flex:0 1 200px"><select id="gfilter" aria-label="Filtrer par joueur">${opts}</select></label></div></div>
      ${list}${more}
    </div></div>`;
}

function viewPlayers() {
  const e = S.editPlayer || {};
  const list = S.players.length ? S.players.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const conf = S.confirm === 'p:' + p.id;
    return `<div class="game"><div style="min-width:0"><div class="vs">${esc(p.name)}</div>
      <div class="meta">${esc([p.chesscom && 'chess.com : ' + p.chesscom, p.lichess && 'Lichess : ' + p.lichess].filter(Boolean).join(' · ') || 'Aucun pseudo')}</div></div>
      <div class="row">${challengeBtn(p, 'Défier')}<button class="btn" data-act="editp" data-id="${esc(p.id)}">Modifier</button>
      ${conf ? `<button class="btn danger" data-act="delp" data-id="${esc(p.id)}">Confirmer</button><button class="btn ghost" data-act="unconfirm">Annuler</button>` : `<button class="btn ghost" data-act="confirm" data-v="p:${esc(p.id)}">Retirer</button>`}</div></div>`;
  }).join('') : '<p class="muted">Personne pour l’instant. Commence par toi.</p>';
  return `<div class="grid2">
    <form class="panel stack" id="pform">
      <h2 class="h2">${e.id ? 'Modifier ' + esc(e.name) : 'Ajouter un joueur'}</h2>
      <label class="f">Prénom ou surnom<input type="text" id="pname" required maxlength="40" value="${esc(e.name || '')}" placeholder="Louis"></label>
      <label class="f">Pseudo chess.com<input type="text" id="pcc" maxlength="40" value="${esc(e.chesscom || '')}" autocapitalize="off" autocomplete="off" placeholder="djlouis"></label>
      <label class="f">Pseudo Lichess<input type="text" id="pli" maxlength="40" value="${esc(e.lichess || '')}" autocapitalize="off" autocomplete="off" placeholder="facultatif"></label>
      <div class="row"><button class="btn primary" type="submit">${e.id ? 'Enregistrer' : 'Ajouter'}</button>${e.id ? '<button class="btn ghost" type="button" data-act="canceledit">Annuler</button>' : ''}</div>
      <p class="muted small" style="margin:0">Les pseudos servent à récupérer ses parties et à les relier à la bonne personne.</p>
    </form>
    <div class="stack">
      <div class="panel"><h2 class="h2" style="margin-bottom:4px">Le groupe</h2>${list}</div>
      ${S.mode === 'shared' ? `<div class="panel stack"><div class="eyebrow">Nom du groupe</div>
        <div class="row"><input type="text" id="grename" maxlength="40" value="${esc(groupName(S.group) === S.group ? '' : groupName(S.group))}" placeholder="Donne un nom au groupe" style="flex:1 1 160px"><button class="btn" data-act="rename">Renommer</button></div></div>
        <div class="panel stack"><div class="eyebrow">Lien à envoyer au groupe</div>
        <input type="text" readonly value="${esc(groupLink())}" aria-label="Lien du groupe" onfocus="this.select()">
        <div><button class="btn" data-act="copylink">Copier le lien</button></div>
        <p class="muted small" style="margin:0">Garde-le entre vous : toute personne qui a ce lien peut voir et modifier le groupe.</p></div>
        <div class="row">${S.confirm === 'leave'
          ? `<button class="btn danger" data-act="leave">Confirmer : retirer ce groupe de cet appareil</button><button class="btn ghost" data-act="unconfirm">Annuler</button>`
          : `<button class="btn ghost" data-act="confirm" data-v="leave">Quitter ce groupe sur cet appareil</button>`}</div>
        <p class="muted small" style="margin:0">Quitter ne supprime rien pour les autres : le lien permet d’y revenir.</p>` : ''}
    </div></div>`;
}

/* --- Bilan --- */
function sqXY(sq, flip) { const f = sq.charCodeAt(0) - 97; const r = +sq[1]; return flip ? [7 - f + 0.5, r - 1 + 0.5] : [f + 0.5, 8 - r + 0.5]; }
function boardHTML(fen, last, cls, arrow, flip) {
  const b = new Chess(fen).board(); let h = '';
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const rr = flip ? 7 - r : r; const ff = flip ? 7 - f : f;
    const sq = 'abcdefgh'[ff] + (8 - rr); const pc = b[rr][ff];
    const dark = (rr + ff) % 2 === 1; const hl = last && (sq === last.from || sq === last.to);
    h += `<div class="sq ${dark ? 'd' : 'l'}${hl ? ' hl' : ''}"${hl && cls ? ` style="--hlc:var(--c-${cls})"` : ''}>`;
    if (f === 0) h += `<span class="coord rk">${8 - rr}</span>`;
    if (r === 7) h += `<span class="coord fl">${'abcdefgh'[ff]}</span>`;
    if (pc) h += `<div class="pc ${pc.color}${pc.type}"></div>`;
    if (last && cls && sq === last.to) h += `<span class="bdg b-${cls}">${CLS[cls].sym}</span>`;
    h += '</div>';
  }
  if (arrow) {
    const [x1, y1] = sqXY(arrow.slice(0, 2), flip); const [x2, y2] = sqXY(arrow.slice(2, 4), flip);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1; const ex = x2 - (dx / len) * 0.32, ey = y2 - (dy / len) * 0.32;
    h += `<svg class="arrows" viewBox="0 0 8 8" aria-hidden="true"><defs><marker id="ah" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--c-best)"/></marker></defs>
      <line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="var(--c-best)" stroke-width="0.17" stroke-linecap="round" opacity="0.85" marker-end="url(#ah)"/></svg>`;
  }
  return h;
}
function graphSVG(a, ply) {
  const W = 600, H = 110, n = a.pos.length - 1 || 1;
  const pts = a.pos.map((p, i) => [(i / n) * W, H - (p.w / 100) * H]);
  const area = `M0,${H} ` + pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ` L${W},${H} Z`;
  const line = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
  const dots = a.ply.map((p, i) => (['blunder', 'mistake', 'brilliant', 'great'].includes(p.c) ? `<circle cx="${pts[i + 1][0].toFixed(1)}" cy="${pts[i + 1][1].toFixed(1)}" r="4" fill="var(--c-${p.c})" stroke="var(--surface)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` : '')).join('');
  const cx = ((ply / n) * W).toFixed(1);
  return `<svg class="graph" id="graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Courbe d’évaluation de la partie">
    <rect width="${W}" height="${H}" fill="var(--bfill)"/>
    <path d="${area}" fill="var(--wfill)"/>
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="var(--graph-mid)" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="var(--c-great)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${dots}</svg>`;
}
function evalStr(e) { return e && e !== '?' ? e : ''; }

function viewAnalysis() {
  const g = S.game;
  if (!g) return `<div class="panel empty"><h2>Choisis une partie</h2><p>Ouvre une partie depuis l’onglet Parties, ou essaie le bilan sur une partie célèbre.</p>
    <div class="row" style="justify-content:center"><button class="btn primary" data-act="go" data-v="parties">Voir les parties</button><button class="btn" data-act="sample">Partie de l’Opéra (1858)</button></div></div>`;
  const p = parsed(g); const n = p.hist.length; const k = Math.max(0, Math.min(S.ply, n));
  const a = g.analysis; const W = sideName(g, 'w'); const B = sideName(g, 'b');
  const last = k > 0 ? p.hist[k - 1] : null; const cls = a && last ? a.ply[k - 1].c : null;
  const prevPos = a && k > 0 ? a.pos[k - 1] : null;
  const arrow = a && last && prevPos && prevPos.b && prevPos.b !== last.lan && !['best', 'brilliant', 'great'].includes(cls) ? prevPos.b : null;
  const curPos = a ? a.pos[k] : null;
  const wPct = curPos ? curPos.w : 50;
  const topSide = S.flip ? 'w' : 'b'; const botSide = S.flip ? 'b' : 'w';
  const pl = (side) => { const x = side === 'w' ? W : B; const elo = side === 'w' ? g.wElo : g.bElo; const acc = a && a.acc[side] != null ? a.acc[side] + ' %' : '';
    return `<div class="pline"><span class="sw" style="background:var(--${side === 'w' ? 'wfill' : 'bfill'})"></span><span class="nm">${esc(x.name)}${elo ? ' <span class="muted">(' + esc(elo) + ')</span>' : ''}</span>${acc ? `<span class="acc" title="Précision">${acc}</span>` : ''}</div>`; };

  let comment;
  if (!last) comment = `<span class="muted">Position de départ. ${a ? 'Utilise les flèches pour parcourir le bilan.' : 'Lance le bilan pour voir la qualité de chaque coup.'}</span>`;
  else if (!a) comment = `<span><strong>${esc(moveLabel(g, k - 1))}</strong></span>`;
  else {
    const c = CLS[cls]; const pl2 = a.ply[k - 1];
    let txt = `<strong>${esc(moveLabel(g, k - 1))}</strong> : <span class="t-${cls}" style="font-weight:700">${c.label.toLowerCase()}</span>, ${c.desc}.`;
    if (!['best', 'brilliant', 'great'].includes(cls) && prevPos && prevPos.bs) txt += ` Le meilleur coup était <strong>${esc(prevPos.bs)}</strong>.`;
    if (pl2.l >= 2) txt += ` <span class="muted">Chances de gain −${Math.round(pl2.l)} %.</span>`;
    if (curPos && evalStr(curPos.e)) txt += ` <span class="muted mono">Éval. ${esc(curPos.e)}</span>`;
    comment = `<span class="b b-${cls}">${c.sym}</span><span>${txt}</span>`;
  }

  // Colonne de droite
  let side = '';
  const job = S.job && S.job.id === g.id ? S.job : null;
  if (job) {
    side += `<div class="panel stack"><div class="eyebrow">Bilan en cours</div><div class="prog"><i id="prog"></i></div>
      <div class="row" style="justify-content:space-between"><span class="small muted" id="progtx"></span><button class="btn ghost" data-act="cancel">Arrêter</button></div>
      <p class="muted small" style="margin:0">Le calcul tourne sur ton appareil. Garde la page ouverte.</p></div>`;
  } else if (!a || S.engineErr) {
    side += `<div class="panel stack"><div><div class="eyebrow">Bilan de la partie</div><h2 class="h2" style="margin-top:4px">${a ? 'Relancer le bilan' : 'Pas encore de bilan'}</h2></div>
      ${S.engineErr ? `<div class="note err">Le moteur n’a pas démarré : ${esc(S.engineErr)}. Essaie sur ordinateur avec Chrome, Edge ou Firefox à jour.</div>` : ''}
      ${depthPicker()}
      <div class="row"><button class="btn primary" data-act="analyze" ${S.job ? 'disabled' : ''}>Lancer le bilan</button>${S.job ? '<span class="small muted">Un autre bilan tourne déjà.</span>' : ''}</div>
      <p class="muted small" style="margin:0">Compte environ ${duration(n + 1, S.depth)} pour cette partie${MOBILE ? ' sur ordinateur, plus sur téléphone' : ''}. ${g.sample ? 'Partie d’essai : le bilan n’est pas enregistré.' : 'Une fois fait, il est enregistré pour tout le groupe.'}</p></div>`;
  }
  if (a) {
    const counts = Object.fromEntries(ORDER.map((c) => [c, { w: 0, b: 0 }]));
    a.ply.forEach((x, i) => counts[x.c][moverOf(g, i)]++);
    // Précision donnée par le site lui-même, quand la partie y a déjà eu son bilan : sert à comparer.
    const siteName = g.site === 'lichess' ? 'Lichess' : 'chess.com';
    const cmp = (s) => (g.siteAcc && g.siteAcc[s] != null ? `<div class="cmp">${siteName} : ${(+g.siteAcc[s]).toFixed(1)}</div>` : '');
    // Elo estimé : celui du joueur sur ses derniers bilans (fiable), et celui de cette partie
    // seule (indicatif), si le joueur a joué assez de coups pour que ça veuille dire quelque chose.
    const elo = (s) => {
      const x = s === 'w' ? W : B; let h = '';
      const pe = x.player && playerElo(x.player);
      if (pe) h += `<div class="elo" title="Moyenne de ses ${pe.n} derniers bilans en rapide, à ± ${ELO_AVG_ERR} près"><span class="mono">${eloText(pe)}</span> Elo estimé</div>`;
      const moves = a.ply.filter((_, i) => moverOf(g, i) === s).length;
      const ge = moves >= ELO_MIN_MOVES ? estimateGameElo(a.acc[s]) : null;
      if (ge) h += `<div class="cmp" title="Sur une seule partie, l’estimation peut se tromper de ${ELO_GAME_ERR} points">Cette partie : ${eloText(ge)} (indicatif)</div>`;
      return h;
    };
    side += `<div class="panel stack">
      <div class="row" style="justify-content:space-between"><div class="eyebrow">Bilan · profondeur ${a.depth}${a.sec != null ? ' · ' + a.sec + ' s' : ''}</div>${g.sample ? '<span class="chip">Partie d’essai</span>' : ''}</div>
      <div class="acc-duo">
        <div class="acc-card"><div class="p">${esc(W.name)}</div><div class="n mono">${a.acc.w ?? '–'}</div><div class="small muted">précision</div>${elo('w')}${cmp('w')}</div>
        <div class="acc-card"><div class="p">${esc(B.name)}</div><div class="n mono">${a.acc.b ?? '–'}</div><div class="small muted">précision</div>${elo('b')}${cmp('b')}</div>
      </div>
      ${graphSVG(a, k)}
      <table class="counts"><tbody>${ORDER.map((c) => `<tr><td class="c">${counts[c].w}</td><td><span class="b b-${c}">${CLS[c].sym}</span> ${CLS[c].label}</td><td class="c">${counts[c].b}</td></tr>`).join('')}</tbody></table>
      <details><summary class="small">Relancer avec une autre profondeur</summary><div class="stack" style="margin-top:10px">${depthPicker()}<div><button class="btn" data-act="analyze" ${S.job ? 'disabled' : ''}>Relancer</button></div></div></details>
    </div>`;
  }
  // Liste des coups
  let rows = ''; const off = g.first === 'b' ? 1 : 0;
  for (let i = -off; i < n; i += 2) {
    const no = Math.floor((i + off) / 2) + 1;
    const cell = (j) => { if (j < 0 || j >= n) return '<span></span>'; const c = a ? a.ply[j].c : null;
      return `<button class="mv" data-act="ply" data-v="${j + 1}" aria-current="${k === j + 1}">${c && c !== 'good' && c !== 'excellent' ? `<span class="b b-${c}">${CLS[c].sym}</span>` : ''}${esc(p.hist[j].san)}</button>`; };
    rows += `<div class="mrow"><span class="no">${no}.</span>${cell(i)}${cell(i + 1)}</div>`;
  }
  side += `<div class="moves" aria-label="Coups de la partie">${rows}</div>`;

  return `<div class="row" style="margin-bottom:12px;justify-content:space-between">
      <button class="btn ghost" data-act="go" data-v="parties">← Parties</button>
      ${g.link ? `<a class="btn ghost" href="${esc(g.link)}" target="_blank" rel="noopener">Voir sur ${g.site === 'lichess' ? 'Lichess' : 'chess.com'} ↗</a>` : ''}
    </div>
    <div class="an">
      <div class="boardcol">
        ${pl(topSide)}
        <div class="boardrow">
          <div class="evalbar ${S.flip ? 'flip' : ''}" aria-label="Barre d’évaluation"><div class="fill" style="height:${wPct}%"></div>
            ${curPos && evalStr(curPos.e) ? `<span class="lab" style="${(wPct >= 50) !== S.flip ? 'bottom:0;color:var(--bfill)' : 'top:0;color:var(--wfill)'}">${esc(curPos.e)}</span>` : ''}</div>
          <div class="board" id="board">${boardHTML(p.fens[k], last, cls, arrow, S.flip)}</div>
        </div>
        ${pl(botSide)}
        <div class="controls">
          <button class="btn" data-act="ply" data-v="0" aria-label="Début">«</button>
          <button class="btn" data-act="step" data-v="-1" aria-label="Coup précédent">‹</button>
          <button class="btn" data-act="step" data-v="1" aria-label="Coup suivant">›</button>
          <button class="btn" data-act="ply" data-v="${n}" aria-label="Fin">»</button>
          <button class="btn" data-act="flip" aria-label="Retourner l’échiquier">⇅</button>
        </div>
        <div class="comment" aria-live="polite">${comment}</div>
      </div>
      <div class="sidecol">${side}</div>
    </div>`;
}
function depthPicker() {
  const opts = DEPTHS;
  const cur = opts.reduce((best, o) => (Math.abs(o[0] - S.depth) < Math.abs(best[0] - S.depth) ? o : best))[0];
  return `<div class="row"><span class="small muted">Profondeur</span><div class="seg" role="group" aria-label="Profondeur">${opts.map(([d, l]) => `<button data-act="depth" data-v="${d}" aria-pressed="${cur === d}">${l}</button>`).join('')}</div></div>`;
}

/* ---------- Actions ---------- */
function openGame(g, ply) { S.game = g; S.ply = ply; S.view = 'analyse'; S.engineErr = null; S.flash = null; render(); scrollTo({ top: 0 }); }
function openSample() {
  const { meta } = parsePgn(OPERA_PGN);
  const g = { id: 'sample-opera', sample: true, pgn: OPERA_PGN, ...meta };
  openGame(S.game && S.game.id === g.id ? S.game : g, 0);
}
async function addPgn() {
  const txt = ($('#pgn') || {}).value || '';
  const parts = splitPgns(txt);
  if (!parts.length) { S.flash = { t: 'err', m: 'Colle d’abord le PGN d’une partie.' }; render(); return; }
  let added = 0, dup = 0; const bad = []; const unknown = new Set();
  for (const pgn of parts) {
    let r; try { r = parsePgn(pgn); } catch (e) { bad.push(e.message || 'PGN illisible'); continue; }
    const id = 'g' + hash([r.meta.white, r.meta.black, r.meta.date, r.hist.map((m) => m.lan).join('')].join('|'));
    if (S.games.some((g) => g.id === id)) { dup++; continue; }
    for (const u of [r.meta.white, r.meta.black]) if (!playerFor(u, r.meta.site)) unknown.add(u);
    addGames([{ id, pgn, ...r.meta, addedAt: new Date().toISOString() }]); added++;
  }
  const msg = [];
  if (added) msg.push(added + ' partie' + (added > 1 ? 's ajoutées' : ' ajoutée'));
  if (dup) msg.push(dup + ' déjà présente' + (dup > 1 ? 's' : ''));
  if (bad.length) msg.push(bad.length + ' illisible' + (bad.length > 1 ? 's' : '') + ' (vérifie que le PGN est complet)');
  if (unknown.size && added) msg.push('pseudos pas encore reliés à un joueur : ' + [...unknown].join(', '));
  S.flash = { t: added ? 'ok' : 'err', m: msg.join(' · ') + '.' };
  if (added && $('#pgn')) $('#pgn').value = '';
  render();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-view],[data-act]'); if (!t) return;
  if (t.dataset.view) { S.view = t.dataset.view; S.flash = null; S.confirm = null; render(); return; }
  const v = t.dataset.v; const act = t.dataset.act;
  if (act === 'go') { S.view = v; S.flash = null; render(); }
  else if (act === 'period') { S.period = v; S.limit = 40; render(); }
  else if (act === 'sample') openSample();
  else if (act === 'open') { const g = S.games.find((x) => x.id === t.dataset.id); if (g) openGame(g, +t.dataset.ply || 0); }
  else if (act === 'addpgn') addPgn();
  else if (act === 'sync') syncGames();
  else if (act === 'duel') { S.duel = { a: t.dataset.a, b: t.dataset.b }; S.view = 'duel'; S.flash = null; render(); scrollTo({ top: 0 }); }
  else if (act === 'between') { S.between = v === 'true'; S.limit = 40; render(); }
  else if (act === 'cadence') { S.rapidOnly = v === 'true'; S.limit = 40; render(); }
  else if (act === 'more') { S.limit += 40; render(); }
  else if (act === 'confirm') { S.confirm = v; render(); }
  else if (act === 'unconfirm') { S.confirm = null; render(); }
  else if (act === 'delgame') { S.confirm = null; removeGame(t.dataset.id); }
  else if (act === 'delp') { S.confirm = null; try { await removePlayer(t.dataset.id); } catch (e) { writeErr(e); } }
  else if (act === 'newgroup') { S.flash = null; joinGroup(newCode(), ($('#gname') || {}).value?.trim().slice(0, 40) || ''); }
  else if (act === 'opengroup') { S.flash = null; joinGroup(v); }
  else if (act === 'leave') { S.confirm = null; forgetGroup(S.group); }
  else if (act === 'rename') {
    const n = ($('#grename') || {}).value?.trim().slice(0, 40) || '';
    if (!n || !remote) return;
    try { await remote.setName(n); rememberGroup(S.group, n); S.flash = { t: 'ok', m: 'Groupe renommé : ' + n + '.' }; } catch (e) { writeErr(e); return; }
    render();
  }
  else if (act === 'joingroup') { const c = cleanCode(($('#gcode') || {}).value); if (c) { S.flash = null; joinGroup(c); } else { S.flash = { t: 'err', m: 'Code invalide : il ressemble à K7Q2X-M9PTA.' }; render(); } }
  else if (act === 'copylink') copyLink();
  else if (act === 'editp') { S.editPlayer = S.players.find((p) => p.id === t.dataset.id) || null; render(); }
  else if (act === 'canceledit') { S.editPlayer = null; render(); }
  else if (act === 'ply') { S.ply = +v; render(); }
  else if (act === 'step') step(+v);
  else if (act === 'flip') { S.flip = !S.flip; render(); }
  else if (act === 'depth') { S.depth = +v; render(); }
  else if (act === 'analyze') { if (S.game) analyze(S.game); }
  else if (act === 'cancel') { if (S.job) S.job.cancel = true; }
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'gfilter') { S.gfilter = ev.target.value; S.limit = 40; render(); }
  else if (ev.target.id === 'gsel') {
    const v = ev.target.value;
    if (v !== '__new') { S.flash = null; joinGroup(v); return; }
    if (S.job) { S.flash = { t: 'err', m: 'Un bilan est en cours : attends la fin ou arrête-le avant de changer de groupe.' }; render(); return; }
    leaveCurrent(); S.group = null; S.mode = 'nogroup'; S.flash = null; history.replaceState(null, '', location.pathname); render();
  }
});
document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'pform') return; ev.preventDefault();
  const name = $('#pname').value.trim(); if (!name) return;
  const cc = $('#pcc').value.trim(); const li = $('#pli').value.trim();
  if (!cc && !li) { S.flash = { t: 'err', m: 'Ajoute au moins un pseudo, chess.com ou Lichess.' }; render(); return; }
  const id = S.editPlayer ? S.editPlayer.id : 'p' + hash(name.toLowerCase() + Date.now());
  const p = { id, name, chesscom: cc, lichess: li };
  try { await savePlayer(p); S.editPlayer = null; S.flash = { t: 'ok', m: name + ' est dans le groupe.' }; render(); } catch (e) { writeErr(e); return; }
  syncGames([p]);
});
document.addEventListener('click', (ev) => {
  const gEl = ev.target.closest('#graph'); if (!gEl || !S.game || !S.game.analysis) return;
  const r = gEl.getBoundingClientRect(); const n = S.game.analysis.pos.length - 1;
  S.ply = Math.max(0, Math.min(n, Math.round(((ev.clientX - r.left) / r.width) * n))); render();
});
function step(d) { if (!S.game) return; const n = parsed(S.game).hist.length; S.ply = Math.max(0, Math.min(n, S.ply + d)); render(); }
document.addEventListener('keydown', (ev) => {
  if (S.view !== 'analyse' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
  if (ev.key === 'ArrowLeft') { step(-1); ev.preventDefault(); }
  else if (ev.key === 'ArrowRight') { step(1); ev.preventDefault(); }
  else if (ev.key === 'Home') { S.ply = 0; render(); }
  else if (ev.key === 'End' && S.game) { S.ply = parsed(S.game).hist.length; render(); }
});
// Glisser horizontalement sur l'échiquier pour avancer / reculer (téléphone)
let tx0 = null;
document.addEventListener('touchstart', (e) => { if (e.target.closest('#board')) tx0 = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', (e) => { if (tx0 == null) return; const dx = e.changedTouches[0].clientX - tx0; tx0 = null; if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1); }, { passive: true });

render();
initStore();
