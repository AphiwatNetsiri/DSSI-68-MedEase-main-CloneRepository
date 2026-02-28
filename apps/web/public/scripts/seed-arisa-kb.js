// scripts/seed-arisa-kb.js
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

import admin from "firebase-admin";
import { getApps } from "firebase-admin/app";
import { FieldValue } from "@google-cloud/firestore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load .env from project root explicitly (apps/web/public/scripts -> ../../../../.env)
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------- Args ----------
function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const KB_PATH = path.resolve(
  PROJECT_ROOT,
  getArg("kb", "scripts/arisa-kb-seed-th.json")
);
const COLLECTION = getArg("collection", "arisa_kb_chunks");
const KB_VERSION = getArg("kbVersion", "th_v1");
const OVERWRITE = hasFlag("overwrite"); // if true -> update existing
const DRY_RUN = hasFlag("dry-run");
const LIMIT = Number(getArg("limit", "0")) || 0;

// Embedding config
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBED_MODEL = process.env.ARISA_EMBED_MODEL || "gemini-embedding-001";
// เลือก 768 เพื่อลดขนาด index/ค่าใช้จ่าย และยังดีพอสำหรับ RAG เบื้องต้น
const EMBED_DIM = Number(process.env.ARISA_EMBED_DIM || "768");

// Batch sizes
const EMBED_BATCH = Number(process.env.ARISA_EMBED_BATCH || "20"); // API batch size
const WRITE_BATCH = Number(process.env.ARISA_WRITE_BATCH || "200"); // Firestore batch writes (<= 500)

// ---------- Helpers ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sha1(text) {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}
function slugify(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-ก-๙]+/g, "")
    .replace(/\-+/g, "-")
    .slice(0, 60);
}
function buildDocId(item) {
  const base = `${item.locale || ""}|${item.topic || ""}|${item.title || ""}|${
    item.text || ""
  }`;
  const h = sha1(base).slice(0, 16);
  return `${slugify(item.topic || "kb")}_${h}`;
}
function buildEmbedText(item) {
  const tags = Array.isArray(item.tags) ? item.tags.join(", ") : "";
  const reds = Array.isArray(item.redFlags) ? item.redFlags.join(" | ") : "";
  return [
    `หัวข้อ: ${item.title || ""}`,
    `หมวด: ${item.topic || ""}`,
    tags ? `แท็ก: ${tags}` : "",
    item.severity ? `ระดับความเร่งด่วน: ${item.severity}` : "",
    item.text || "",
    reds ? `สัญญาณอันตราย (red flags): ${reds}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- Firebase Admin init ----------
function initFirebaseAdmin() {
  if (getApps().length) return;

  // พยายามใช้ serviceAccountKey.json ในโปรเจกต์ก่อน (เหมือนที่ index.js ทำ)
  const saPath = path.join(PROJECT_ROOT, "serviceAccountKey.json");
  if (fs.existsSync(saPath)) {
    const raw = JSON.parse(fs.readFileSync(saPath, "utf8"));
    admin.initializeApp({
      credential: admin.credential.cert(raw),
      projectId: raw.project_id
    });
    console.log("[FIREBASE] Using serviceAccountKey.json:", raw.project_id);
    return;
  }

  // fallback: ใช้ Application Default Credentials
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
  console.log("[FIREBASE] Using applicationDefault credentials");
}

// ---------- Gemini Embedding (REST) ----------
async function geminiBatchEmbed({ texts, titles }) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY in .env");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;

  // สร้าง requests แบบ “ลองได้หลายรูปแบบ”
  const baseRequests = texts.map((t, i) => ({
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text: t }] },
    taskType: "RETRIEVAL_DOCUMENT",
    title: titles?.[i] || undefined,
  }));

  const variants = [
    // 1) camelCase
    { requests: baseRequests.map((r) => ({ ...r, outputDimensionality: EMBED_DIM })) },
    // 2) snake_case
    { requests: baseRequests.map((r) => ({ ...r, output_dimensionality: EMBED_DIM })) },
    // 3) ไม่ส่ง field นี้เลย (ให้ model คืน default dim)
    { requests: baseRequests },
  ];

  let lastErr = null;

  for (const body of variants) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      lastErr = new Error(
        `Gemini batchEmbedContents failed: ${res.status} ${res.statusText} :: ${msg}`
      );
      // ลอง variant ถัดไป
      continue;
    }

    const json = await res.json();

    const embeddings = (json.embeddings || []).map((e) => e?.values || null);

    if (!embeddings.length || embeddings.some((v) => !Array.isArray(v))) {
      lastErr = new Error("Unexpected embedding response shape (missing embeddings[].values[])");
      continue;
    }

    // ถ้าไม่ได้ dim ตามที่เราต้องการ ให้ fail (เพราะ Firestore index ล็อกไว้ 768)
    const badDim = embeddings.find((v) => v.length !== EMBED_DIM);
    if (badDim) {
      lastErr = new Error(
        `Embedding dimension mismatch: expected ${EMBED_DIM}, got ${badDim.length}`
      );
      continue;
    }

    return embeddings;
  }

  throw lastErr || new Error("Gemini batchEmbedContents failed");
}

// ---------- Main ----------
async function main() {
  console.log("=== Arisa KB Seed ===");
  console.log("KB_PATH:", KB_PATH);
  console.log("COLLECTION:", COLLECTION);
  console.log("KB_VERSION:", KB_VERSION);
  console.log("EMBED_MODEL:", EMBED_MODEL);
  console.log("EMBED_DIM:", EMBED_DIM);
  console.log("OVERWRITE:", OVERWRITE);
  console.log("DRY_RUN:", DRY_RUN);
  console.log("LIMIT:", LIMIT || "(no limit)");

  if (!fs.existsSync(KB_PATH)) {
    throw new Error(`KB file not found: ${KB_PATH}`);
  }

  const raw = fs.readFileSync(KB_PATH, "utf8");
  let items = JSON.parse(raw);

  if (!Array.isArray(items)) {
    throw new Error("KB JSON must be an array");
  }
  if (LIMIT > 0) items = items.slice(0, LIMIT);

  // Validate minimal fields
  items = items.map((it, idx) => {
    if (!it.title || !it.text || !it.topic) {
      throw new Error(`KB item #${idx} missing required fields: title/text/topic`);
    }
    return {
      locale: it.locale || "th-TH",
      topic: it.topic,
      title: it.title,
      tags: Array.isArray(it.tags) ? it.tags : [],
      severity: it.severity || "info",
      text: it.text,
      redFlags: Array.isArray(it.redFlags) ? it.redFlags : [],
      source: it.source || { org: "unknown", type: "unknown", note: "" }
    };
  });

  // Build embed inputs
  const embedTexts = items.map(buildEmbedText);
  const titles = items.map((x) => x.title);

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would embed ${items.length} items and write to Firestore.`);
    console.log("Example embedText[0]:\n", embedTexts[0]);
    return;
  }

  initFirebaseAdmin();
  const db = admin.firestore();

  // Embed in batches
  const allEmbeddings = [];
  for (let i = 0; i < embedTexts.length; i += EMBED_BATCH) {
    const chunkTexts = embedTexts.slice(i, i + EMBED_BATCH);
    const chunkTitles = titles.slice(i, i + EMBED_BATCH);

    let attempt = 0;
    while (true) {
      try {
        attempt += 1;
        const vecs = await geminiBatchEmbed({ texts: chunkTexts, titles: chunkTitles });
        allEmbeddings.push(...vecs);
        console.log(`[EMBED] ${i}..${i + chunkTexts.length - 1} OK`);
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        const wait = 800 * attempt;
        console.warn(`[EMBED] retry #${attempt} after ${wait}ms ::`, e.message);
        await sleep(wait);
      }
    }

    // กันโดน rate limit ง่าย ๆ
    await sleep(250);
  }

  if (allEmbeddings.length !== items.length) {
    throw new Error("Embedding count mismatch");
  }

  // Write to Firestore (batched)
  let written = 0;
  for (let i = 0; i < items.length; i += WRITE_BATCH) {
    const batch = db.batch();
    const slice = items.slice(i, i + WRITE_BATCH);

    for (let j = 0; j < slice.length; j++) {
      const item = slice[j];
      const emb = allEmbeddings[i + j];

      const docId = buildDocId(item);
      const ref = db.collection(COLLECTION).doc(docId);

      const now = FieldValue.serverTimestamp();
      const embedHash = sha1(buildEmbedText(item));

      const doc = {
        kbVersion: KB_VERSION,
        locale: item.locale,
        topic: item.topic,
        title: item.title,
        tags: item.tags,
        severity: item.severity,
        text: item.text,
        redFlags: item.redFlags,
        source: item.source,

        // embedding metadata
        embedModel: EMBED_MODEL,
        embedDim: EMBED_DIM,
        embedHash,
        embedTextPreview: buildEmbedText(item).slice(0, 500),

        // vector field (สำคัญสำหรับ Firestore Vector Search)
        embedding: FieldValue.vector(emb),

        updatedAt: now,
        ...(OVERWRITE ? {} : { createdAt: now })
      };

      batch.set(ref, doc, { merge: true });
    }

    await batch.commit();
    written += slice.length;
    console.log(`[WRITE] committed ${written}/${items.length}`);
  }

  console.log("✅ Done. Seeded KB items:", items.length);
  console.log(`Collection: ${COLLECTION} (field: embedding, dim: ${EMBED_DIM})`);
}

main().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});
