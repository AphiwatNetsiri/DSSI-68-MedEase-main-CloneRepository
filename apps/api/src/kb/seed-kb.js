// file: apps/api/src/kb/seed-kb.js
// Seed MedEase KB (JSON) -> chunk -> embed (Gemini) -> Firestore (arisa_kb_chunks)
//
// Required env:
// - GEMINI_API_KEY
// Optional env:
// - ARISA_KB_COLLECTION (default: arisa_kb_chunks)
// - ARISA_KB_VERSION (default: th_v1)
// - ARISA_EMBED_MODEL (default: text-embedding-004)
// - ARISA_EMBED_DIM (default: 768)
// - FIREBASE_PROJECT_ID (optional)
// - FIREBASE_SERVICE_ACCOUNT_JSON (optional) or GOOGLE_APPLICATION_CREDENTIALS_JSON (optional)

import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KB_PATH_DEFAULT = path.join(__dirname, "medease_faq.th.json");
const KB_PATH_ENV = (process.env.ARISA_KB_FILE || "").trim();
const KB_PATH = KB_PATH_ENV || KB_PATH_DEFAULT;

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--collection" || a === "-c") out.collection = argv[++i];
    else if (a === "--version" || a === "-v") out.version = argv[++i];
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--ollama-model") out.ollamaModel = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const ARGS = parseArgs();
const KB_PATH_RUNTIME = (ARGS.file || KB_PATH).trim();

if (ARGS.help) {
  console.log(`\nUsage:\n  node apps/api/src/kb/seed-kb.js [--file <json>] [--collection <name>] [--version <kbVersion>]\n                                 [--provider gemini|ollama|none] [--ollama-model <model>]\n\n`);
  process.exit(0);
}


const ARISA_KB_COLLECTION = (ARGS.collection || process.env.ARISA_KB_COLLECTION || "arisa_kb_chunks").trim();
const ARISA_KB_VERSION = (ARGS.version || process.env.ARISA_KB_VERSION || "th_v1").trim();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ARISA_EMBED_MODEL = process.env.ARISA_EMBED_MODEL || "text-embedding-004";
const ARISA_EMBED_DIM = Number(process.env.ARISA_EMBED_DIM || 768);

// Embedding provider: "gemini" | "ollama" | "none"
// Default: gemini (if GEMINI_API_KEY set) else ollama (if OLLAMA_URL set) else none
const EMBED_PROVIDER = (ARGS.provider || process.env.EMBED_PROVIDER || "").toLowerCase();
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_EMBED_MODEL = (ARGS.ollamaModel || process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text").trim();

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || undefined;


function _tryReadJsonFile(p) {
  try {
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw);
    if (obj && obj.project_id && obj.client_email && obj.private_key) return obj;
    return null;
  } catch {
    return null;
  }
}

function loadServiceAccount() {
  // Priority 1: JSON string env
  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    "";
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.project_id && obj.client_email && obj.private_key) return obj;
    } catch {}
  }

  // Priority 2: explicit path env
  const p1 =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    "";
  const fromPath = _tryReadJsonFile(p1);
  if (fromPath) return fromPath;

  // Priority 3: auto-detect common locations in this repo
  const candidates = [
    // most likely
    path.join(process.cwd(), "apps", "api", "src", "secrets"),
    path.join(process.cwd(), "apps", "api", "secrets"),
    path.join(process.cwd(), "secrets"),
    // relative to this file (apps/api/src/kb)
    path.join(__dirname, "..", "secrets"),
    path.join(__dirname, "..", "..", "secrets"),
  ];

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs
        .readdirSync(dir)
        .filter((f) => /\.json$/i.test(f) && /adminsdk|serviceaccount|firebase/i.test(f));
      for (const f of files) {
        const full = path.join(dir, f);
        const obj = _tryReadJsonFile(full);
        if (obj) {
          console.log("[SEED][FIREBASE] using service account file:", full);
          return obj;
        }
      }
    } catch {}
  }

  return null;
}

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const serviceAccount = loadServiceAccount();

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: FIREBASE_PROJECT_ID || serviceAccount.project_id,
    });
    console.log("[SEED][FIREBASE] init", {
      projectId: FIREBASE_PROJECT_ID || serviceAccount.project_id || "(from serviceAccount)",
      hasServiceAccount: true,
    });
    return;
  }

  // Fallback: application default (requires gcloud auth / workload identity)
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: FIREBASE_PROJECT_ID,
  });

  console.log("[SEED][FIREBASE] init", {
    projectId: FIREBASE_PROJECT_ID || "(auto)",
    hasServiceAccount: false,
  });
}


async function _getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  const mod = await import("node-fetch");
  return mod.default;
}

async function geminiEmbedOne({ text, taskType = "RETRIEVAL_DOCUMENT" }) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  const fetch = await _getFetch();
  const urlEmbed = `https://generativelanguage.googleapis.com/v1beta/models/${ARISA_EMBED_MODEL}:embedContent`;

  const payloads = [
    {
      model: `models/${ARISA_EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: ARISA_EMBED_DIM,
    },
    {
      model: `models/${ARISA_EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
      output_dimensionality: ARISA_EMBED_DIM,
    },
    { model: `models/${ARISA_EMBED_MODEL}`, content: { parts: [{ text }] }, taskType },
  ];

  let lastErr = null;

  for (const body of payloads) {
    try {
      const res = await fetch(urlEmbed, {
        method: "POST",
        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Gemini embed error ${res.status}: ${t.slice(0, 250)}`);
      }

      const data = await res.json();
      const vec =
        data?.embedding?.values ||
        data?.embedding?.value ||
        data?.embedding ||
        null;

      if (!Array.isArray(vec) || vec.length < 8) {
        throw new Error("Invalid embedding response");
      }

      return vec;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Embed failed");
}

async function ollamaEmbedOne({ text }) {
  const fetch = await _getFetch();
  const url = `${OLLAMA_URL.replace(/\/+$/, "")}/api/embeddings`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Ollama embed error ${res.status}: ${t.slice(0, 250)}`);
  }

  const data = await res.json().catch(() => ({}));
  const vec = data?.embedding;
  if (!Array.isArray(vec) || vec.length < 8) {
    throw new Error("Invalid Ollama embedding response");
  }
  return vec;
}

function pickEmbedProvider() {
  if (EMBED_PROVIDER === "gemini" || EMBED_PROVIDER === "ollama" || EMBED_PROVIDER === "none") {
    return EMBED_PROVIDER;
  }
  if (GEMINI_API_KEY) return "gemini";
  if (OLLAMA_URL) return "ollama";
  return "none";
}

async function embedOne({ text, taskType = "RETRIEVAL_DOCUMENT" }) {
  const provider = pickEmbedProvider();

  if (provider === "gemini") {
    return { provider, embedding: await geminiEmbedOne({ text, taskType }) };
  }
  if (provider === "ollama") {
    return { provider, embedding: await ollamaEmbedOne({ text }) };
  }

  // none: write chunk without embedding (keyword-only KB). Retrieval must fallback to text search.
  return { provider: "none", embedding: null };
}

function clampStr(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, n).trim() + "…";
}

// chunk แบบง่าย: แบ่งด้วยขนาดตัวอักษร + overlap
function chunkText(text, { maxChars = 900, overlap = 120 } = {}) {
  const t = String(text || "").trim();
  if (!t) return [];

  const out = [];
  let i = 0;

  while (i < t.length) {
    const end = Math.min(t.length, i + maxChars);
    const chunk = t.slice(i, end).trim();
    if (chunk) out.push(chunk);

    if (end >= t.length) break;
    i = Math.max(0, end - overlap);
  }

  return out;
}

function buildDocText(item) {
  const title = item?.title ? `หัวข้อ: ${item.title}\n` : "";
  const topic = item?.topic ? `หมวด: ${item.topic}\n` : "";
  const tags = Array.isArray(item?.tags) && item.tags.length ? `แท็ก: ${item.tags.join(", ")}\n` : "";
  const body = item?.text ? String(item.text).trim() : "";
  return `${title}${topic}${tags}\n${body}`.trim();
}

async function seed() {
  initFirebaseAdmin();
  const db = admin.firestore();

  if (!fs.existsSync(KB_PATH_RUNTIME)) {
    throw new Error(`KB file not found: ${KB_PATH_RUNTIME}`);
  }

  const raw = fs.readFileSync(KB_PATH_RUNTIME, "utf-8");
  let items;
  try {
    items = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in KB file: ${KB_PATH_RUNTIME} (${e?.message || e})`);
  }


  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("KB JSON must be a non-empty array");
  }

  console.log("[SEED] items =", items.length);
  const _prov = pickEmbedProvider();
  if (_prov === "none") {
    console.warn("[SEED][WARN] No embedding provider configured. Chunks will be stored WITHOUT embeddings (keyword-only). Set GEMINI_API_KEY or EMBED_PROVIDER=ollama + OLLAMA_EMBED_MODEL.");
  }
  console.log("[SEED] target =", { kbFile: KB_PATH_RUNTIME, collection: ARISA_KB_COLLECTION, kbVersion: ARISA_KB_VERSION, embedProvider: pickEmbedProvider(), ollamaModel: OLLAMA_EMBED_MODEL, geminiModel: ARISA_EMBED_MODEL });

  let totalChunks = 0;
  let written = 0;

  // batch write (จำกัด 450 ops ต่อ batch)
  let batch = db.batch();
  let ops = 0;

  for (const item of items) {
    const baseText = buildDocText(item);
    const chunks = chunkText(baseText, { maxChars: 900, overlap: 140 });

    for (let ci = 0; ci < chunks.length; ci++) {
      const text = chunks[ci];
      totalChunks++;

      const { provider: embeddingProvider, embedding } = await embedOne({ text, taskType: "RETRIEVAL_DOCUMENT" });

      const docId = `${ARISA_KB_VERSION}__${item.id || "item"}__${String(ci).padStart(3, "0")}`;
      const ref = db.collection(ARISA_KB_COLLECTION).doc(docId);

      const payload = {
        kbVersion: ARISA_KB_VERSION,
        sourceId: item.id || null,
        topic: item.topic || "",
        title: item.title || "",
        tags: Array.isArray(item.tags) ? item.tags : [],
        severity: item.severity || "info",
        redFlags: Array.isArray(item.redFlags) ? item.redFlags : [],
        source: item.source || "",
        updatedAt: item.updatedAt || "",
        chunkIndex: ci,
        text,
        textPreview: clampStr(text, 220),
        embeddingProvider,
        embedding,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      batch.set(ref, payload, { merge: true });
      ops++;
      written++;

      if (ops >= 450) {
        await batch.commit();
        console.log(`[SEED] committed ${written}/${totalChunks} chunks...`);
        batch = db.batch();
        ops = 0;
      }
    }
  }

  if (ops > 0) {
    await batch.commit();
  }

  console.log("[SEED] DONE ✅", { totalChunks, written });
  console.log("[SEED] Collection:", ARISA_KB_COLLECTION, "Version:", ARISA_KB_VERSION);
}

seed().catch((e) => {
  console.error("[SEED] FAILED ❌", e?.message || e);
  process.exitCode = 1;
});