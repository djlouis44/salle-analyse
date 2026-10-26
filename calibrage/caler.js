// Calage de la précision sur celle de chess.com, à partir de window.CAL (calibrer.html).
// Les évaluations brutes y sont gardées du point de vue du camp au trait, ce qui permet de
// tester d'autres réglages sans relancer le moteur. Recherche par grille, puis grille plus fine.
import { Chess } from '../chess.js';

export function prep(CAL) {
  return CAL.games.map((g) => {
    const c = new Chess(); c.loadPgn(g.pgn);
    const hist = c.history({ verbose: true });
    return { url: g.url, elo: g.elo, cc: g.cc, ours: g.ours, raw: g.raw, cls: g.cls.split(','),
      moves: hist.map((m) => m.lan), term: c.isCheckmate() ? 'mate' : c.isGameOver() ? 'draw' : null };
  });
}

const wp = (line, k) => (line[0] === 'm' ? (line[1] > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-k * line[1])) - 1));

function curve(g, k) {
  const n = g.raw.length;
  return g.raw.map((r, i) => (r ? wp(r[1], k) : (i === n - 1 && g.term === 'mate' ? 0 : 50)));
}
function lossesOf(g, k) {
  const stm = curve(g, k);
  return g.moves.map((mv, i) => (g.raw[i] && g.raw[i][0] === mv ? 0 : Math.max(0, stm[i] - (100 - stm[i + 1]))));
}
function volatility(g, k) {
  const stm = curve(g, k); const white = stm.map((s, i) => (i % 2 ? 100 - s : s));
  const n = white.length - 1; const size = Math.floor(Math.min(8, Math.max(2, n / 10))); const out = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, Math.min(i, n - size)); const w = white.slice(lo, lo + size + 1);
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
    out.push(Math.min(12, Math.max(0.5, sd)));
  }
  return out;
}
const moveAcc = (l, c) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-c * l) - 3.1669));

// m = { k, c, e (pente selon l'Elo), vol (pondération Lichess), bookFull (théorique = 100) }
export function predict(G, m) {
  const rows = [];
  for (const g of G) {
    for (const side of [0, 1]) {
      const elo = g.elo[side];
      const k = m.k * Math.exp((m.e || 0) * (elo - 1200) / 1000);
      const ls = lossesOf(g, k); const vol = m.vol ? volatility(g, k) : null;
      const idx = ls.map((_, i) => i).filter((i) => i % 2 === side);
      if (idx.length < 8) continue;
      const acc = idx.map((i) => (m.bookFull && g.cls[i] === 'book' ? 100 : moveAcc(ls[i], m.c)));
      const w = vol ? idx.map((i) => vol[i]) : idx.map(() => 1);
      const mean = acc.reduce((s, a, j) => s + a * w[j], 0) / w.reduce((s, x) => s + x, 0);
      const harm = acc.length / acc.reduce((s, a) => s + 1 / Math.max(a, 10), 0);
      rows.push({ p: (mean + harm) / 2, t: g.cc[side], elo });
    }
  }
  return rows;
}
export const mae = (rows) => rows.reduce((s, r) => s + Math.abs(r.p - r.t), 0) / rows.length;
const bias = (rows) => rows.reduce((s, r) => s + (r.p - r.t), 0) / rows.length;

export function report(rows) {
  const byElo = [[0, 600], [600, 1000], [1000, 1400], [1400, 1800], [1800, 2200], [2200, 4000]].map(([lo, hi]) => {
    const r = rows.filter((x) => x.elo >= lo && x.elo < hi);
    return r.length ? `${lo}-${hi}: ${mae(r).toFixed(1)} (${bias(r) >= 0 ? '+' : ''}${bias(r).toFixed(1)}, n=${r.length})` : null;
  }).filter(Boolean);
  return { erreur: +mae(rows).toFixed(2), biais: +bias(rows).toFixed(2), n: rows.length, parElo: byElo };
}

export function fit(G, base) {
  let best = { ...base, k: 0.00368208, c: 0.04354 }; let bestErr = mae(predict(G, best));
  const steps = [[0.0005, 0.005, 0.2], [0.0001, 0.001, 0.05], [0.00002, 0.0002, 0.01]];
  for (const [dk, dc, de] of steps) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const sk of [-2, -1, 0, 1, 2]) for (const sc of [-2, -1, 0, 1, 2]) for (const se of base.e != null ? [-1, 0, 1] : [0]) {
        const m = { ...best, k: best.k + sk * dk, c: best.c + sc * dc, e: base.e != null ? (best.e || 0) + se * de : undefined };
        if (m.k <= 0 || m.c <= 0) continue;
        const err = mae(predict(G, m));
        if (err < bestErr - 1e-4) { best = m; bestErr = err; improved = true; }
      }
    }
  }
  return best;
}
