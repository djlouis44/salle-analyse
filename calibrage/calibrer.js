// Calibrage : récupère des parties rapides chess.com déjà passées au bilan (précision officielle
// dans l'API publique), les analyse avec notre moteur et garde les évaluations brutes de chaque
// position. Le calage des formules se fait ensuite hors ligne sur window.CAL.
import { Chess } from '../chess.js';
import { summarizePosition, buildAnalysis, parseInfo, loadBook } from '../core.js';

const P = new URLSearchParams(location.search);
const N = +P.get('n') || 60;
const DEPTH = +P.get('depth') || 12;
const NW = +P.get('workers') || 4;
const BUCKETS = [[0, 600], [600, 1000], [1000, 1400], [1400, 1800], [1800, 2200], [2200, 4000]];
const PER = Math.ceil(N / BUCKETS.length);

const logEl = document.getElementById('log');
const log = (s) => { logEl.textContent += s + '\n'; logEl.scrollTop = 1e9; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

window.CAL = { meta: { depth: DEPTH, at: new Date().toISOString() }, games: [], done: false };

async function api(url) {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(url);
    if (r.status === 429) { await sleep(5000); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

// 1. Échantillon : des joueurs de tous niveaux, puis leurs adversaires.
async function sample() {
  const picked = new Map(); const count = BUCKETS.map(() => 0);
  // Joueurs français au hasard (surtout débutants) + joueurs titrés (haut niveau), mélangés.
  const seen = new Set(); const seeds = ['denlaz'];
  const fr = await api('https://api.chess.com/pub/country/FR/players');
  if (fr && fr.players) seeds.push(...shuffle(fr.players).slice(0, 80));
  for (const t of ['CM', 'NM', 'WCM', 'FM']) {
    const r = await api('https://api.chess.com/pub/titled/' + t);
    if (r && r.players) seeds.push(...shuffle(r.players).slice(0, 25));
  }
  const queue = ['denlaz', ...shuffle(seeds.slice(1))];
  let visits = 0;
  while (queue.length && visits < 400 && count.some((c) => c < PER)) {
    const u = queue.shift().toLowerCase(); if (seen.has(u)) continue; seen.add(u); visits++;
    const arch = await api(`https://api.chess.com/pub/player/${u}/games/archives`);
    await sleep(150);
    if (!arch || !arch.archives || !arch.archives.length) continue;
    const month = await api(arch.archives[arch.archives.length - 1]);
    await sleep(150);
    if (!month || !month.games) continue;
    const opp = [];
    for (const g of shuffle(month.games)) {
      if (g.rules !== 'chess' || g.time_class !== 'rapid' || !g.pgn) continue;
      const other = g.white.username.toLowerCase() === u ? g.black : g.white;
      opp.push(other.username);
      if (!g.accuracies || picked.has(g.uuid)) continue;
      if ((g.pgn.match(/\d+\. /g) || []).length < 12) continue; // au moins une douzaine de coups
      const avg = (g.white.rating + g.black.rating) / 2;
      const b = BUCKETS.findIndex(([lo, hi]) => avg >= lo && avg < hi);
      if (b < 0 || count[b] >= PER) continue;
      picked.set(g.uuid, g); count[b]++;
      break; // une partie par joueur, pour varier
    }
    queue.push(...shuffle(opp).slice(0, 3));
    if (visits % 10 === 0) log(`… ${visits} joueurs vus, parties retenues par tranche d'Elo : ${count.join(' / ')}`);
  }
  log(`Échantillon : ${picked.size} parties (${count.join(' / ')}) après ${visits} joueurs.`);
  return [...picked.values()];
}

// 2. Moteur : plusieurs Stockfish en parallèle, mêmes réglages que l'appli (MultiPV 2).
class Eng {
  constructor() {
    this.w = new Worker('../moteur/stockfish-18-lite-single.js');
    this.ready = new Promise((res) => {
      this.w.onmessage = (e) => {
        const l = String(e.data);
        if (l === 'uciok') { this.w.postMessage('setoption name MultiPV value 2'); this.w.postMessage('setoption name Hash value 32'); this.w.postMessage('isready'); }
        else if (l === 'readyok') res();
      };
      this.w.postMessage('uci');
    });
  }
  evaluate(fen, depth) {
    return new Promise((res) => {
      const lines = {};
      this.w.onmessage = (e) => {
        const l = String(e.data);
        const x = parseInfo(l); if (x) { lines[x.mpv] = x.line; return; }
        if (l.startsWith('bestmove')) res({ lines: [lines[1], lines[2]].filter(Boolean), best: l.split(' ')[1] });
      };
      this.w.postMessage('position fen ' + fen);
      this.w.postMessage('go depth ' + depth);
    });
  }
}

async function analyseGame(eng, g, book) {
  const c = new Chess(); c.loadPgn(g.pgn);
  const hist = c.history({ verbose: true });
  const fens = [hist[0].before, ...hist.map((m) => m.after)];
  const pos = []; const raw = [];
  for (const fen of fens) {
    const over = new Chess(fen).isGameOver();
    const res = over ? null : await eng.evaluate(fen, DEPTH);
    pos.push(summarizePosition(fen, res));
    raw.push(res ? [res.best, ...res.lines.map((l) => [l.type === 'mate' ? 'm' : 'c', l.v])] : null);
  }
  const a = buildAnalysis(hist, pos, DEPTH, book);
  return {
    url: g.url, elo: [g.white.rating, g.black.rating],
    cc: [g.accuracies.white, g.accuracies.black],
    ours: [a.acc.w, a.acc.b],
    cls: a.ply.map((p) => p.c).join(','),
    raw, pgn: g.pgn,
  };
}

async function main() {
  log(`Profondeur ${DEPTH}, ${NW} moteurs, objectif ${N} parties.`);
  const book = await loadBook();
  const games = await sample();
  const engs = Array.from({ length: NW }, () => new Eng());
  await Promise.all(engs.map((e) => e.ready));
  log('Moteurs prêts, analyse en cours…');
  let next = 0; const t0 = performance.now();
  await Promise.all(engs.map(async (eng) => {
    while (next < games.length) {
      const g = games[next++];
      try {
        const r = await analyseGame(eng, g, book);
        window.CAL.games.push(r);
        log(`${window.CAL.games.length}/${games.length}  Elo ${r.elo.join('-')}  chess.com ${r.cc.join(' / ')}  nous ${r.ours.join(' / ')}  (${Math.round((performance.now() - t0) / 1000)} s)`);
      } catch (e) { log('Partie ignorée : ' + e.message); }
    }
  }));
  window.CAL.done = true;
  log('Terminé.');
}
main().catch((e) => log('Erreur : ' + e.message));
