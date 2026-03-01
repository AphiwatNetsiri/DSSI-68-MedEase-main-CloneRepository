import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--collection" || a === "-c") out.collection = argv[++i];
    else if (a === "--version" || a === "-v") out.version = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const ARGS = parseArgs();

if (ARGS.help) {
  console.log(`
Usage:
  node apps/api/src/kb/delete-kb-version.js --collection arisa_kb_chunks --version th_v1 [--dry-run] [--limit 10000]
`);
  process.exit(0);
}

const COLLECTION = (ARGS.collection || "arisa_kb_chunks").trim();
const KB_VERSION = (ARGS.version || "th_v1").trim();
const LIMIT_CAP = Number.isFinite(ARGS.limit) ? ARGS.limit : 10000;

function _tryReadJsonFile(p) {
  try {
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (obj?.project_id && obj?.client_email && obj?.private_key) return obj;
    return null;
  } catch {
    return null;
  }
}

function loadServiceAccount() {
  const envPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    "";
  const fromEnvPath = _tryReadJsonFile(envPath);
  if (fromEnvPath) {
    console.log("[DEL][FIREBASE] using service account file:", envPath);
    return fromEnvPath;
  }

  const candidates = [
    path.join(process.cwd(), "apps", "api", "src", "serviceAccountKey.json"),
    path.join(process.cwd(), "apps", "api", "secrets"),
    path.join(process.cwd(), "apps", "api", "src", "secrets"),
    path.join(process.cwd(), "secrets"),
    path.join(__dirname, "..", "secrets"),
    path.join(__dirname, "..", "..", "secrets"),
  ];

  for (const p of candidates) {
    if (p.endsWith(".json")) {
      const obj = _tryReadJsonFile(p);
      if (obj) {
        console.log("[DEL][FIREBASE] using service account file:", p);
        return obj;
      }
    }
  }

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = fs
        .readdirSync(dir)
        .filter((f) => /\.json$/i.test(f) && /adminsdk|serviceaccount|firebase/i.test(f));
      for (const f of files) {
        const full = path.join(dir, f);
        const obj = _tryReadJsonFile(full);
        if (obj) {
          console.log("[DEL][FIREBASE] using service account file:", full);
          return obj;
        }
      }
    } catch {}
  }

  return null;
}

function initAdmin() {
  if (admin.apps.length) return;

  const sa = loadServiceAccount();
  const projectId = sa?.project_id || process.env.FIREBASE_PROJECT_ID || "medeasehosting";

  admin.initializeApp({
    credential: sa ? admin.credential.cert(sa) : admin.credential.applicationDefault(),
    projectId,
  });

  console.log("[DEL][FIREBASE] init", { projectId, hasServiceAccount: !!sa });
}

async function deleteByKbVersion() {
  initAdmin();
  const db = admin.firestore();
  const col = db.collection(COLLECTION);

  let total = 0;
  let deleted = 0;
  let lastDoc = null;

  while (true) {
    let q = col.where("kbVersion", "==", KB_VERSION).orderBy("__name__").limit(400);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    total += snap.size;
    if (total > LIMIT_CAP) {
      console.error(`[DEL] Safety cap reached (${LIMIT_CAP}). Stop.`);
      process.exitCode = 2;
      break;
    }

    const first = snap.docs[0]?.id;
    const last = snap.docs[snap.docs.length - 1]?.id;

    if (ARGS.dryRun) {
      console.log(`[DEL][DRY] would delete batch size=${snap.size} idRange=${first}..${last}`);
    } else {
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
      deleted += snap.size;
      console.log(`[DEL] deleted ${deleted} docs...`);
    }

    lastDoc = snap.docs[snap.docs.length - 1] || null;
    if (!lastDoc) break;
  }

  if (ARGS.dryRun) {
    console.log(`[DEL][DRY] done. would delete total≈${total} docs for kbVersion=${KB_VERSION}`);
  } else {
    console.log(`[DEL] DONE ✅ deleted=${deleted} (kbVersion=${KB_VERSION}, collection=${COLLECTION})`);
  }
}

deleteByKbVersion().catch((e) => {
  console.error("[DEL] FAILED ❌", e?.message || e);
  process.exitCode = 1;
});
