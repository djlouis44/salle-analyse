// La Gazette du club, les records et les défis de la semaine. Calculs seulement : l'affichage est
// dans app.js. Tout part d'une liste d'« entrées », une par partie et par joueur du groupe qui l'a jouée :
//   { g, side, p, o, t, duel }
//   g : la partie (avec son bilan s'il existe)   side : 'w' ou 'b'   p : le joueur du groupe
//   o : 'w', 'd' ou 'l' (null si pas finie)      t : fin de la partie en ms
//   duel : les deux camps sont des joueurs du groupe

const DAY = 86400000;
const mover = (g, i) => ((i % 2 === 0) === ((g.first || 'w') === 'w') ? 'w' : 'b');
// Coups du joueur de l'entrée, avec leur indice dans la partie (vide sans bilan).
function myPly(e) {
  const a = e.g.analysis; if (!a) return [];
  const out = [];
  a.ply.forEach((x, i) => { if (mover(e.g, i) === e.side) out.push({ c: x.c, l: x.l, i }); });
  return out;
}
const accOf = (e) => (e.g.analysis && e.g.analysis.acc ? e.g.analysis.acc[e.side] ?? null : null);
const eloOf = (e) => +(e.side === 'w' ? e.g.wElo : e.g.bElo) || null;
const isRapid = (g) => !g.timeClass || g.timeClass === 'rapid';

// Chances de gain du joueur au plus bas et au plus haut de la partie (bilan nécessaire). On saute
// la position de départ et la dernière : le résultat y est déjà écrit (mat, abandon).
export function swing(e) {
  const pos = e.g.analysis && e.g.analysis.pos; if (!pos || pos.length < 4) return null;
  let lo = 100, hi = 0;
  for (const x of pos.slice(1, -1)) {
    if (typeof x.w !== 'number') continue;
    const v = e.side === 'w' ? x.w : 100 - x.w;
    if (v < lo) lo = v; if (v > hi) hi = v;
  }
  return { lo, hi };
}

// L'élément qui a la meilleure note (null si la liste est vide).
function best(list, score) {
  let b = null, bs = -Infinity;
  for (const x of list) { const s = score(x); if (s != null && s > bs) { b = x; bs = s; } }
  return b;
}
function byPlayer(es) {
  const m = new Map();
  for (const e of es) { if (!m.has(e.p.id)) m.set(e.p.id, []); m.get(e.p.id).push(e); }
  return m;
}
// Plus longue série de victoires dans les entrées d'un même joueur. Une nulle ou une défaite la coupe.
function streakOf(es) {
  const s = es.filter((e) => e.o).sort((a, b) => a.t - b.t);
  let n = 0, top = { n: 0 };
  s.forEach((e, k) => {
    if (e.o !== 'w') { n = 0; return; }
    n++; if (n > top.n) top = { n, p: e.p, first: s[k - n + 1], last: e };
  });
  return top;
}
// Évolution de l'Elo d'un joueur sur ses entrées : on prend le site et la cadence où il a le plus joué.
// L'API donne l'Elo de chaque partie, l'écart entre la première et la dernière est donc approché.
function eloMove(es) {
  const groups = new Map();
  for (const e of es) {
    if (!eloOf(e) || !e.g.timeClass) continue;
    const k = e.g.site + '|' + e.g.timeClass;
    if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e);
  }
  const list = best([...groups.values()].filter((l) => l.length >= 2), (l) => l.length);
  if (!list) return null;
  list.sort((a, b) => a.t - b.t);
  return { diff: eloOf(list[list.length - 1]) - eloOf(list[0]), n: list.length, site: list[0].g.site, timeClass: list[0].g.timeClass };
}
const RANK = { brilliant: 2, great: 1 };
function moments(es) { return es.flatMap((e) => myPly(e).map((x) => ({ e, i: x.i, c: x.c, l: x.l }))); }
function swings(es) { return es.map((e) => ({ e, s: swing(e) })).filter((x) => x.s); }

// Lundi 0 h de la semaine courante (offset 0), de la précédente (-1), etc., heure locale.
export function weekStart(offset = 0, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * offset);
  return d.getTime();
}

/* ---------- La Gazette : la semaine du groupe ---------- */
export function gazette(entries, from, to) {
  const es = entries.filter((e) => e.t >= from && e.t < to);
  const per = [...byPlayer(es).values()].map((list) => {
    const s = { p: list[0].p, n: list.length, w: 0, d: 0, l: 0, elo: eloMove(list) };
    list.forEach((e) => { if (e.o) s[e.o]++; });
    return s;
  }).sort((a, b) => b.n - a.n || b.w - a.w);
  const an = es.filter((e) => e.g.analysis);
  const mv = moments(an); const sw = swings(an);
  const duels = [...new Map(es.filter((e) => e.duel).map((e) => [e.g.id, e.g])).values()].sort((a, b) => (b.end || 0) - (a.end || 0));
  return {
    games: new Set(es.map((e) => e.g.id)).size,
    analysed: new Set(an.map((e) => e.g.id)).size,
    players: per,
    bestAcc: best(an.filter((e) => myPly(e).length >= 10), accOf),
    topMove: best(mv.filter((m) => RANK[m.c]), (m) => RANK[m.c] * 1e13 + m.e.t),
    blunder: best(mv.filter((m) => m.c === 'blunder'), (m) => m.l),
    comeback: best(sw.filter((x) => x.e.o === 'w' && x.s.lo <= 30), (x) => -x.s.lo),
    collapse: best(sw.filter((x) => (x.e.o === 'l' || x.e.o === 'd') && x.s.hi >= 85), (x) => x.s.hi),
    climber: best(per.filter((s) => s.elo && s.elo.diff > 0 && s.elo.n >= 3), (s) => s.elo.diff),
    duels,
  };
}

/* ---------- Records du club ---------- */
export function records(entries) {
  const an = entries.filter((e) => e.g.analysis);
  const wins = entries.filter((e) => e.o === 'w');
  // Journée la plus chargée d'un joueur.
  const days = new Map();
  for (const e of entries) {
    const k = e.p.id + '|' + new Date(e.t).toDateString();
    const d = days.get(k) || { p: e.p, t: e.t, n: 0 }; d.n++; days.set(k, d);
  }
  // Elo le plus haut en rapide, un record par site (les classements Lichess sont plus hauts).
  const peaks = new Map();
  for (const e of entries) {
    if (e.g.timeClass !== 'rapid' || !eloOf(e)) continue;
    const cur = peaks.get(e.g.site);
    if (!cur || eloOf(e) > eloOf(cur)) peaks.set(e.g.site, e);
  }
  return {
    bestAcc: best(an.filter((e) => myPly(e).length >= 15), accOf),
    streak: best([...byPlayer(entries).values()].map(streakOf).filter((s) => s.n >= 2), (s) => s.n),
    comeback: best(swings(an.filter((e) => e.o === 'w')), (x) => -x.s.lo),
    blunder: best(moments(an).filter((m) => m.c === 'blunder'), (m) => m.l),
    // Pas en dessous de 4 coups : une partie gagnée au temps sur une déconnexion ne compte pas.
    quickWin: best(wins.filter((e) => e.g.plies >= 8), (e) => -e.g.plies),
    marathon: best(entries, (e) => e.g.plies),
    busyDay: best([...days.values()].filter((d) => d.n >= 3), (d) => d.n),
    peaks: [...peaks.values()].map((e) => ({ e, elo: eloOf(e) })),
  };
}

/* ---------- Défis de la semaine ---------- */
// Trois défis par semaine, tirés au sort d'après le numéro de la semaine : tout le groupe a les
// mêmes sans rien enregistrer. Comptés sur les parties rapides. Ceux marqués « bilan » ne voient
// que les parties analysées.
const CHALLENGES = [
  { id: 'volume', title: 'Assidu', text: 'Jouer 10 parties rapides dans la semaine.', target: 10, count: (es) => es.length },
  { id: 'streak', title: 'En série', text: 'Gagner 3 parties d’affilée.', target: 3, count: (es) => streakOf(es).n },
  { id: 'black', title: 'Côté noir', text: 'Gagner 3 parties avec les Noirs.', target: 3, count: (es) => es.filter((e) => e.side === 'b' && e.o === 'w').length },
  { id: 'duel', title: 'Entre nous', text: 'Jouer 2 parties contre quelqu’un du groupe.', target: 2, count: (es) => es.filter((e) => e.duel).length },
  { id: 'long', title: 'Jusqu’au bout', text: 'Gagner une partie de plus de 40 coups.', target: 1, count: (es) => es.filter((e) => e.o === 'w' && e.g.plies > 80).length },
  { id: 'clean', title: 'Sans gaffe', text: 'Finir 3 parties d’au moins 15 coups sans une seule gaffe.', target: 3, bilan: true,
    count: (es) => es.filter((e) => { const m = myPly(e); return m.length >= 15 && !m.some((x) => x.c === 'blunder'); }).length },
  { id: 'sharp', title: 'Chirurgical', text: 'Une partie d’au moins 15 coups à 85 % de précision ou plus.', target: 1, bilan: true,
    count: (es) => es.filter((e) => myPly(e).length >= 15 && accOf(e) >= 85).length },
  { id: 'steady', title: 'Régulier', text: '5 parties à 70 % de précision ou plus.', target: 5, bilan: true,
    count: (es) => es.filter((e) => myPly(e).length >= 10 && accOf(e) >= 70).length },
  { id: 'brill', title: 'Coup de génie', text: 'Jouer un coup brillant (!!) ou excellent (!).', target: 1, bilan: true,
    count: (es) => es.reduce((n, e) => n + myPly(e).filter((x) => RANK[x.c]).length, 0) },
  { id: 'comeback', title: 'Jamais mort', text: 'Gagner une partie après être tombé sous 30 % de chances de gain.', target: 1, bilan: true,
    count: (es) => es.filter((e) => e.o === 'w' && (swing(e)?.lo ?? 100) <= 30).length },
];
const mix = (x) => (Math.imul(x, 2654435761) >>> 0);
// Au moins un défi faisable sans bilan, pour que chacun puisse jouer même sans rien analyser.
export function weekChallenges(from) {
  const wk = Math.round(from / (7 * DAY));
  const plain = CHALLENGES.filter((c) => !c.bilan);
  const first = plain[mix(wk) % plain.length];
  const rest = CHALLENGES.filter((c) => c !== first);
  const second = rest[mix(wk + 1) % rest.length];
  const rest2 = rest.filter((c) => c !== second);
  return [first, second, rest2[mix(wk + 2) % rest2.length]];
}
export function challenges(entries, players, from, to) {
  const per = byPlayer(entries.filter((e) => e.t >= from && e.t < to && isRapid(e.g)));
  return weekChallenges(from).map((c) => ({
    ...c,
    rows: players.map((p) => { const n = Math.min(c.target, c.count(per.get(p.id) || [])); return { p, n, done: n >= c.target }; })
      .sort((a, b) => b.n - a.n || a.p.name.localeCompare(b.p.name)),
  }));
}
