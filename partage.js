// Partage des groupes dans Firestore. Chaque groupe est rangé sous groupes/<code> :
//   groupes/<code>          : { name } (nom affiché du groupe)
//   joueurs/<id>            : { name, chesscom, lichess }
//   bilans/<id>             : la partie (PGN et infos) + son bilan, pour que tout le groupe le voie
//   duels/<id>              : les parties entre deux joueurs du groupe (PGN et infos, sans bilan)
// Les parties elles-mêmes ne sont pas stockées : chaque appareil les récupère sur chess.com
// et Lichess. Ça garde le nombre de lectures loin du quota gratuit.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1 : rien à confondre
const CODE_RE = /^[A-Z2-9]{5}-[A-Z2-9]{5}$/;

export const enabled = !!firebaseConfig.projectId;
export const appCheck = enabled && !!firebaseConfig.appCheckKey;

// 10 caractères tirés au hasard : environ 10^15 codes possibles, impossible à deviner.
export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  const s = [...r].map((x) => ALPHA[x % ALPHA.length]).join('');
  return s.slice(0, 5) + '-' + s.slice(5);
}

// Accepte le code seul (avec ou sans tiret) ou le lien entier envoyé par les amis : sur iPhone,
// l'appli installée ne partage pas la mémoire de Safari, on y colle donc souvent le lien.
export function cleanCode(s) {
  const t = String(s || '');
  const inLink = /[?&]g=([^&#\s]+)/.exec(t);
  const c = (inLink ? inLink[1] : t).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const code = c.slice(0, 5) + '-' + c.slice(5, 10);
  return CODE_RE.test(code) ? code : null;
}

// Firebase n'est chargé et initialisé qu'une fois, même si on change de groupe.
let fs = null, db = null;
async function init() {
  if (db) return;
  const [{ initializeApp }, f] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-firestore.js')]);
  fs = f;
  const app = initializeApp(firebaseConfig);
  // App Check : Firestore n'accepte que les requêtes venues de ce site (jeton reCAPTCHA v3), ce qui
  // empêche un script extérieur de vider le quota avec la clé publique. Sans clé, rien ne change.
  // Le blocage lui-même s'active dans la console Firebase (App Check > Cloud Firestore > Appliquer).
  if (firebaseConfig.appCheckKey) {
    try {
      const ac = await import(SDK + 'firebase-app-check.js');
      ac.initializeAppCheck(app, { provider: new ac.ReCaptchaV3Provider(firebaseConfig.appCheckKey), isTokenAutoRefreshEnabled: true });
    } catch (_) { /* hors ligne : Firestore lit son cache local */ }
  }
  // Cache local : l'appli s'affiche tout de suite au rechargement, même hors ligne.
  db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
}

// Ouvre un groupe et écoute les changements en direct. Renvoie les fonctions d'écriture,
// et close() pour arrêter l'écoute quand on passe à un autre groupe.
// since (ms) : ne lire que les bilans des parties finies depuis cette date. Chaque ouverture
// relit les bilans écoutés : sans limite, le quota gratuit fondrait à mesure qu'ils s'accumulent.
export async function openGroup(code, { onInfo, onPlayers, onBilans, onDuels, onError }, { since = 0 } = {}) {
  await init();
  const base = 'groupes/' + code + '/';
  const bilansQ = since ? fs.query(fs.collection(db, base + 'bilans'), fs.where('end', '>=', since)) : fs.collection(db, base + 'bilans');
  const unsubs = [
    // Le nom est facultatif : une erreur ici (règles pas encore à jour) ne bloque rien.
    fs.onSnapshot(fs.doc(db, 'groupes', code), (d) => onInfo(d.exists() ? d.data() : {}), () => onInfo({})),
    fs.onSnapshot(fs.collection(db, base + 'joueurs'), (s) => onPlayers(s.docs.map((d) => ({ ...d.data(), id: d.id }))), onError),
    fs.onSnapshot(bilansQ, (s) => onBilans(s.docs.map((d) => ({ ...d.data(), id: d.id }))), onError),
    // Comme le nom : sans les nouvelles règles, pas de duels partagés, mais rien ne casse.
    fs.onSnapshot(fs.collection(db, base + 'duels'), (s) => onDuels(s.docs.map((d) => ({ ...d.data(), id: d.id }))), () => onDuels([])),
  ];
  return {
    close: () => unsubs.forEach((u) => u()),
    setName: (name) => fs.setDoc(fs.doc(db, 'groupes', code), { name }),
    putPlayer: ({ id, ...p }) => fs.setDoc(fs.doc(db, base + 'joueurs', id), p),
    delPlayer: (id) => fs.deleteDoc(fs.doc(db, base + 'joueurs', id)),
    putBilan: ({ id, ...b }) => fs.setDoc(fs.doc(db, base + 'bilans', id), b),
    putDuel: ({ id, ...d }) => fs.setDoc(fs.doc(db, base + 'duels', id), d),
  };
}
