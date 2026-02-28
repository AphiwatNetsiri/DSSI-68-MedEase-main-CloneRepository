// scripts/test-arisa-kb-search.js
import "dotenv/config";
import admin from "firebase-admin";
import { getApps } from "firebase-admin/app";

// ใช้ Firestore client (มักติดมากับ firebase-admin อยู่แล้ว)
import { Firestore } from "@google-cloud/firestore"; // (คงไว้ตามไฟล์เดิม)

// ===== Config =====
const COLLECTION = process.env.ARISA_KB_COLLECTION || "arisa_kb_chunks";
const KB_VERSION = process.env.ARISA_KB_VERSION || "th_v1";
const LIMIT = Number(process.env.ARISA_KB_LIMIT || 5);
const EXPECTED_DIM = Number(process.env.ARISA_KB_EMBED_DIM || 768);

// ===== Init Firebase Admin =====
if (!getApps().length) {
  // ถ้าโปรเจกต์คุณใช้ serviceAccountKey.json อยู่แล้ว ให้คงวิธีเดิม
  // (ส่วนใหญ่มีไฟล์นี้ใน root)
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

// ใช้ Firestore จาก admin SDK ได้เลย
const db = admin.firestore();

// ===== Embedding (Gemini REST: embedContent) =====
// IMPORTANT: REST ต้องใช้ output_dimensionality (snake_case) ไม่ใช่ outputDimensionality
async function embedTextGemini(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in .env");

  // ให้ตรงกับที่ seed ใช้ (default: gemini-embedding-001)
  const model = process.env.ARISA_EMBED_MODEL || "gemini-embedding-001";

  // ใช้ endpoint embedContent + task_type=RETRIEVAL_QUERY + output_dimensionality=768
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      task_type: "RETRIEVAL_QUERY",
      output_dimensionality: EXPECTED_DIM, // ✅ ใช้ชื่อนี้ใน REST
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini embed failed: ${res.status} ${t}`);
  }

  const data = await res.json();
  // โครงสร้าง response ของ embedContent
  const vec = data?.embedding?.values || data?.embeddings?.[0]?.values;
  if (!Array.isArray(vec)) throw new Error("No embedding values in response");

  if (EXPECTED_DIM && vec.length !== EXPECTED_DIM) {
    throw new Error(
      `Embedding dim mismatch: got ${vec.length}, expected ${EXPECTED_DIM}. Check output_dimensionality/model settings.`
    );
  }

  return vec;
}

async function main() {
  const q = process.argv.slice(2).join(" ").trim();
  if (!q) {
    console.log('Usage: node scripts/test-arisa-kb-search.js "อาการ..."');
    process.exit(0);
  }

  console.log("=== KB Vector Search Test ===");
  console.log("Collection:", COLLECTION);
  console.log("KB_VERSION:", KB_VERSION);
  console.log("Query:", q);

  const queryVector = await embedTextGemini(q);
  console.log("Embedding dim:", queryVector.length);

  // ===== Vector search =====
  // ต้องมี index READY แล้ว
  // ใช้ findNearest() ของ Firestore query
  const ref = db.collection(COLLECTION);

  const snap = await ref
    .where("kbVersion", "==", KB_VERSION)
    .findNearest("embedding", queryVector, {
      limit: LIMIT,
      distanceMeasure: "COSINE",
    })
    .get();

  console.log(`\nTop ${snap.size} results:`);
  let i = 1;
  snap.forEach((doc) => {
    const d = doc.data();
    console.log(
      `\n#${i++} ${d.title || "(no title)"} | topic=${d.topic} | severity=${d.severity}`
    );
    console.log("tags:", (d.tags || []).join(", "));
    console.log(
      "text:",
      (d.text || "").slice(0, 220) + (d.text?.length > 220 ? "..." : "")
    );
  });
}

main().catch((e) => {
  console.error("\n❌ ERROR:", e.message);
  process.exit(1);
});
