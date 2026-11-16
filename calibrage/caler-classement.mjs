// Calage du classement des coups sur les bilans chess.com relevés le 2026-11-16.
// Même logique que buildAnalysis (core.js), mais chaque réglage est un paramètre : on cherche ceux
// qui maximisent l'accord coup par coup avec chess.com, sans relancer le moteur.
// Usage : node calibrage/caler-classement.mjs [profondeur]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from '../chess.js';
import { isSacrifice, openingName } from '../core.js';

const DIR = fileURLToPath(new URL('./bilans-2026-11/', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEPTH = +process.argv[2] || 12;
const BOOK = JSON.parse(readFileSync(ROOT + 'ouvertures.json', 'utf8'));
const games = JSON.parse(readFileSync(DIR + 'parties.json', 'utf8')).parties;
const CC = JSON.parse(readFileSync(DIR + 'chesscom.json', 'utf8')).bilans;
const RAW = JSON.parse(readFileSync(DIR + `brut-p${DEPTH}.json`, 'utf8'));
const FROM_CC = { brilliant: 'brilliant', great_find: 'great', best: 'best', skills: 'best', excellent: 'excellent',
  good: 'good', book: 'book', inaccuracy: 'inaccuracy', mistake: 'mistake', incorrect: 'miss', blunder: 'blunder', forced: 'forced' };
const BAD = ['inaccuracy', 'mistake', 'miss', 'blunder'];
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Pré-calcul de tout ce qui ne dépend pas des réglages.
export const G = [];
for (const g of games) {
  const cc = CC[g.id]; const raw = RAW[g.id]; if (!cc || !raw) continue;
  const c = new Chess(); c.loadPgn(g.pgn);
  const hist = c.history({ verbose: true });
  if (cc.cls.length !== hist.length) { console.log('longueurs différentes', g.id); continue; }
  const fens = [hist[0].before, ...hist.map((m) => m.after)];
  const P = fens.map((fen, i) => {
    const x = new Chess(fen); const r = raw[i];
    const term = x.isCheckmate() ? 'mate' : x.isGameOver() ? 'draw' : null;
    return { term, legal: term ? 0 : x.moves().length, b: r && r.b, l1: r && r.l[0], l2: r && r.l[1], book: !!openingName(BOOK, fen),
      // Matériel gagné par la ligne du moteur (pour « Manqué » : il y avait quelque chose à prendre).
      gain: r && r.l[0] && r.l[0][2] ? gainOf(fen, r.l[0][2]) : 0 };
  });
  const M = hist.map((m, i) => ({ lan: m.lan, color: m.color, sac: isSacrifice(m), recap: i > 0 && !!hist[i - 1].captured && hist[i - 1].to === m.to,
    elo: m.color === 'w' ? g.elo[0] : g.elo[1], cap: m.captured ? VAL[m.captured] : 0 }));
  G.push({ id: g.id, elo: (g.elo[0] + g.elo[1]) / 2, P, M, cc: cc.cls.map((x) => FROM_CC[x] || '?') });
}
function gainOf(fen, pv) {
  const c = new Chess(fen); const me = c.turn(); let net = 0, best = 0;
  for (const u of pv.split(' ').slice(0, 6)) {
    let m; try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch (_) { break; }
    if (!m) break;
    if (m.captured) net += (m.color === me ? 1 : -1) * VAL[m.captured];
    if (m.color !== me) best = Math.max(best, net); // gain une fois la réponse adverse jouée
  }
  return best;
}

// Mat en n pour le camp au trait en A, et pour le même camp après son coup (B est vu de l'adversaire).
function missedMate(A, B) {
  const nb = A.l1 && A.l1[0] === 'mate' && A.l1[1] > 0 ? A.l1[1] : null;
  if (nb == null || nb > 5 || B.term) return false;
  const na = B.l1 && B.l1[0] === 'mate' && B.l1[1] < 0 ? -B.l1[1] : null;
  return na == null || (nb <= 2 && na > nb);
}
const wp = (l, k) => (!l ? 50 : l[0] === 'mate' ? (l[1] > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-k * l[1])) - 1));
function stmOf(p, k) { if (p.term === 'mate') return 0; if (p.term === 'draw') return 50; return wp(p.l1, k); }

export function classifyGame(g, o) {
  const out = []; let inBook = true;
  for (let i = 0; i < g.M.length; i++) {
    const m = g.M[i]; const A = g.P[i]; const B = g.P[i + 1];
    const k = o.k * Math.exp((o.e || 0) * (m.elo - 1200) / 1000);
    const wpB = stmOf(A, k); const wpA = 100 - stmOf(B, k);
    const exact = A.b === m.lan;
    const gap = A.l2 ? wpB - wp(A.l2, k) : null;
    // Coup joué = 2e ligne du moteur : l'écart entre les deux lignes d'une même recherche est plus
    // stable que la différence entre deux recherches séparées (avant / après le coup).
    const second = o.useL2 && A.l2 && A.l2[2] === m.lan;
    const loss = exact ? 0 : second ? Math.max(0, gap) : Math.max(0, wpB - wpA);
    let c = exact ? 'best' : loss < o.t1 ? 'excellent' : loss < o.t2 ? 'good' : loss < o.t3 ? 'inaccuracy' : loss < o.t4 ? 'mistake' : 'blunder';
    if (o.forced && A.legal === 1) c = 'forced';
    else if (inBook && loss < o.bookLoss && (B.book || (o.bookExt && i < o.bookExt && (exact || second)))) c = 'book';
    else {
      inBook = false;
      if ((c === 'best' || c === 'excellent') && wpB < o.brilCap && wpA >= 50 && m.sac) c = 'brilliant';
      else if (c === 'best' && gap != null && gap >= o.gGap && wpB < o.gCap && !(o.gNoRecap && m.recap)) c = 'great';
      // Punition d'une faute : prendre ce que l'adversaire vient de laisser (chess.com dit « Excellent »).
      else if (o.gPunish && c === 'best' && i > 0 && BAD.includes(out[i - 1]) && m.cap >= o.gPunish) c = 'great';
      // Manqué : il y avait du matériel à gagner (ligne du moteur) ou une position gagnante, et le coup le laisse passer.
      else if (BAD.includes(c) && loss >= o.mLoss && (A.gain >= o.mGain || (i > 0 && BAD.includes(out[i - 1]) && wpB >= o.mWp))) c = 'miss';
      // Mat forcé laissé passer (règle de core.js depuis le 2026-10-26).
      else if (o.mate && c !== 'brilliant' && missedMate(A, B)) c = 'miss';
    }
    out.push(c);
  }
  return out;
}

export function score(o, subset = G) {
  let ok = 0, n = 0;
  for (const g of subset) {
    const ours = classifyGame(g, o);
    ours.forEach((c, i) => { const t = g.cc[i]; if (t === '?') return; n++; if (c === t || (t === 'forced' && c === 'best')) ok++; });
  }
  return ok / n;
}

// Point de départ : les réglages actuels de core.js.
const BASE = { k: 0.00368208, e: 0, t1: 2, t2: 5, t3: 10, t4: 20, forced: true, bookLoss: 10, bookExt: 0,
  brilCap: 95, gGap: 15, gCap: 95, gNoRecap: true, gPunish: 0, mLoss: 1e9, mGain: 99, mWp: 70, useL2: false };
// Réglage actuel exact pour « Manqué » (cls mistake/blunder après une faute, wpB ≥ 70) : approché par mLoss 10.
const CUR = { ...BASE, forced: false, mLoss: 10, mGain: 99, mWp: 70 };

const STEPS = {
  k: [0.0002, 0.00005], e: [0.2, 0.05], t1: [1, 0.25], t2: [1, 0.25], t3: [2, 0.5], t4: [3, 1],
  bookExt: [2, 1], gGap: [3, 1], gCap: [3, 1], gPunish: [1, 1], mLoss: [2, 0.5], mGain: [1, 1], mWp: [5, 2],
};
export function fit(start, keys, subset = G) {
  let best = { ...start }; let bs = score(best, subset);
  for (const pass of [0, 1]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const key of keys) for (const dir of [-1, 1]) {
        const cand = { ...best, [key]: +(best[key] + dir * STEPS[key][pass]).toFixed(6) };
        if (cand[key] < 0 || !(cand.t1 <= cand.t2 && cand.t2 <= cand.t3 && cand.t3 <= cand.t4)) continue;
        const s = score(cand, subset); if (s > bs + 1e-6) { best = cand; bs = s; improved = true; }
      }
    }
  }
  for (const key of ['gNoRecap', 'useL2']) for (const b of [true, false]) { const cand = { ...best, [key]: b }; const s = score(cand, subset); if (s > bs) { best = cand; bs = s; } }
  return { o: best, s: bs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`Profondeur ${DEPTH}, ${G.length} parties, ${G.reduce((s, g) => s + g.M.length, 0)} coups.`);
  console.log('Réglages actuels (approchés) :', (100 * score(CUR)).toFixed(1), '%');
  const keys = ['k', 'e', 't1', 't2', 't3', 't4', 'bookExt', 'gGap', 'gCap', 'gPunish', 'mLoss', 'mGain', 'mWp'];
  const hasL2 = G.some((g) => g.P.some((p) => p.l2 && p.l2[2]));
  const starts = [{ ...BASE, mLoss: 5, mGain: 2, gPunish: 1 }, ...(hasL2 ? [{ ...BASE, mLoss: 5, mGain: 2, gPunish: 1, useL2: true }] : [])];
  const fitBest = (subset) => starts.map((s) => fit(s, keys, subset)).sort((a, b) => b.s - a.s)[0];
  const r = fitBest(G);
  console.log('Calé :', (100 * r.s).toFixed(1), '%', JSON.stringify(r.o));
  // Validation croisée : calé sur une moitié des parties, mesuré sur l'autre.
  const A = G.filter((_, i) => i % 2 === 0); const B = G.filter((_, i) => i % 2 === 1);
  const ra = fitBest(A); const rb = fitBest(B);
  console.log(`Validation croisée : calé sur A → ${(100 * score(ra.o, B)).toFixed(1)} % sur B (actuel ${(100 * score(CUR, B)).toFixed(1)}) ; calé sur B → ${(100 * score(rb.o, A)).toFixed(1)} % sur A (actuel ${(100 * score(CUR, A)).toFixed(1)})`);
}
