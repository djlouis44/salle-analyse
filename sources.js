// Récupération des parties sur chess.com et Lichess, appelés directement depuis le navigateur (CORS ouvert).
// Chaque partie est ramenée au même format, quelle que soit sa source :
// { id, site, url, pgn, white, black, wElo, bElo, result, end, timeClass, tc, acc }

const CC = 'https://api.chess.com/pub/player/';
const LI = 'https://lichess.org/api/games/user/';
const MONTH = 31 * 86400000;

export class SourceError extends Error {}

async function get(url, who, headers) {
  let r;
  try { r = await fetch(url, { headers }); } catch (_) { throw new SourceError('Pas de réponse de ' + who + ' : vérifie ta connexion.'); }
  if (r.status === 404) throw new SourceError('Pseudo introuvable sur ' + who + '.');
  if (r.status === 429) throw new SourceError(who + ' limite les appels : réessaie dans une minute.');
  if (!r.ok) throw new SourceError(who + ' a répondu une erreur (' + r.status + ').');
  return r;
}
const getJson = async (url, who) => (await get(url, who)).json();

function pgnResult(pgn) {
  const m = /\[Result "([^"]+)"\]/.exec(pgn || '');
  return m ? m[1] : '*';
}

function fromChessCom(g) {
  return {
    id: 'cc_' + g.uuid,
    site: 'chesscom',
    url: g.url,
    pgn: g.pgn,
    white: g.white.username,
    black: g.black.username,
    wElo: g.white.rating || null,
    bElo: g.black.rating || null,
    result: pgnResult(g.pgn),
    end: g.end_time * 1000,
    timeClass: g.time_class,
    tc: g.time_control,
    // Présent seulement si la partie a déjà eu son bilan sur chess.com : utile pour comparer.
    acc: g.accuracies ? { w: g.accuracies.white, b: g.accuracies.black } : null,
  };
}

// Options communes aux deux sources :
//   max      : nombre maximum de parties en rapide
//   maxOther : nombre maximum de parties des autres cadences (0 = rapides seulement)
//   months   : jusqu'où remonter
// Deux plafonds séparés, sinon un joueur qui enchaîne les blitz noie ses rapides.

// Parties récentes d'un joueur chess.com, de la plus récente à la plus ancienne.
// L'API range les parties par mois : on remonte les archives jusqu'à en avoir assez.
export async function chessComGames(user, { max = 10, maxOther = 0, months = 3 } = {}) {
  const u = String(user || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,25}$/.test(u)) throw new SourceError('Pseudo chess.com invalide.');
  const { archives } = await getJson(CC + u + '/games/archives', 'chess.com');
  const out = [];
  let rapid = 0, other = 0;
  for (const url of archives.slice(-months).reverse()) {
    const { games } = await getJson(url, 'chess.com');
    const keep = games.filter((g) => g.rules === 'chess' && g.pgn).sort((a, b) => b.end_time - a.end_time);
    for (const g of keep) {
      if (g.time_class === 'rapid' ? rapid++ < max : other++ < maxOther) out.push(fromChessCom(g));
      if (rapid >= max && other >= maxOther) return out;
    }
  }
  return out;
}

function lichessName(p) {
  if (p.user) return p.user.name;
  return p.aiLevel ? 'Stockfish niveau ' + p.aiLevel : 'Anonyme';
}

function fromLichess(g) {
  const acc = (side) => g.players[side].analysis?.accuracy;
  return {
    id: 'li_' + g.id,
    site: 'lichess',
    url: 'https://lichess.org/' + g.id,
    pgn: g.pgn,
    white: lichessName(g.players.white),
    black: lichessName(g.players.black),
    wElo: g.players.white.rating || null,
    bElo: g.players.black.rating || null,
    result: pgnResult(g.pgn),
    end: g.lastMoveAt,
    timeClass: g.speed,
    tc: g.clock ? g.clock.initial + '+' + g.clock.increment : '-',
    acc: acc('white') != null ? { w: acc('white'), b: acc('black') } : null,
  };
}

async function lichessQuery(u, perfType, max, months) {
  const q = new URLSearchParams({
    max: max + 5, // marge pour les parties écartées ci-dessous
    since: Date.now() - months * MONTH,
    perfType,
    pgnInJson: 'true',
    accuracy: 'true',
  });
  const text = await (await get(LI + u + '?' + q, 'Lichess', { Accept: 'application/x-ndjson' })).text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((g) => g.variant === 'standard' && g.pgn)
    .map(fromLichess)
    .filter((g) => g.result !== '*')
    .slice(0, max);
}

// Parties récentes d'un joueur Lichess. Ici le serveur filtre et trie lui-même, réponse en
// NDJSON (une partie JSON par ligne). Lichess demande un appel à la fois : on les enchaîne.
export async function lichessGames(user, { max = 10, maxOther = 0, months = 3 } = {}) {
  const u = String(user || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(u)) throw new SourceError('Pseudo Lichess invalide.');
  const out = await lichessQuery(u, 'rapid', max, months);
  if (maxOther > 0) out.push(...await lichessQuery(u, 'ultraBullet,bullet,blitz,classical,correspondence', maxOther, months));
  return out;
}

// Les deux sources d'un joueur, fusionnées et triées. Une source en échec n'empêche pas l'autre.
export async function playerGames({ chesscom, lichess }, opts = {}) {
  const jobs = [];
  if (chesscom) jobs.push(chessComGames(chesscom, opts));
  if (lichess) jobs.push(lichessGames(lichess, opts));
  const res = await Promise.allSettled(jobs);
  const games = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  games.sort((a, b) => b.end - a.end);
  return { games, errors: res.filter((r) => r.status === 'rejected').map((r) => r.reason) };
}
