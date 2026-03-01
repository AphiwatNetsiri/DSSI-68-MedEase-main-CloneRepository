// file: apps/api/src/index.js
// ================== index.js ==================
// patched: เพิ่ม API /admin/doctor-schedules/notify-now สำหรับ “ส่งแจ้งเตือนทันที”
// patched: notify-now ใช้ได้ทั้ง admin/staff (เฉพาะ endpoint นี้) โดยเพิ่ม requireStaffOrAdmin
// patched: ปรับ CRON upcoming reminder ให้ใช้ “เวลา absolute” + window 50–120 นาที
// patched(A): field หายไป = ยังไม่เคยส่ง (remind1hSent/summarySent missing => send)
// patched(UI): notify-now / cron เตือนก่อนเริ่ม / cron สรุปพรุ่งนี้ ส่ง Flex UI + ปุ่มลิงก์ (รองรับ carousel)
// patched(KB): KB short answer 3 blocks + KB 1 line + Quick Reply 3 ชุด
// patched(2025-12-23): heuristic ดัก “คำอาการ” => SYMPTOM_CHECK + default quick reply เมนูหลัก
// PATCH(2025-12-24): default เรียก n8n LLM ก่อน แล้วค่อย fallback
// PATCH(2026-01-10): harden CORS, require CRON_SECRET (no default), fix vector distance, dynamic KB reply,
//                    normalize notify-now time, remove duplicate cron endpoint (410), remove top-level await,
//                    add Ollama fallback with guardrails
// PATCH(2026-01-10-B): add /debug/ollama endpoint (fix: Cannot POST /debug/ollama), guarded for localhost or DEBUG_SECRET
// PATCH(2026-02-25 Phase A): harden Firestore Memory context (timeout + clamp + trim) with safe fallback

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import express from "express";
import rateLimit from "express-rate-limit";
import { Client, middleware } from "@line/bot-sdk";

// ===== PDF สำหรับใบรับรองแพทย์ =====
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// ===== Firebase Admin =====
import admin from "firebase-admin";
import { getApps } from "firebase-admin/app";

// ===== Intent engine =====
import { loadIntentSamples, classifyIntent, routeIntent } from "./intent.js";
import { logIntent } from "./utils/intent-logger.js";

// ===== Symptom checker (Infermedica) =====
import { triage } from "./symptom.js";

// ===== Path / env setup =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ================== Ollama (Local LLM) ==================
// ใช้ Node >= 18 จะมี fetch ในตัว
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL_RAW =
  process.env.OLLAMA_MODEL || "scb10x/llama3.2-typhoon2-3b-instruct";
const OLLAMA_MODEL = OLLAMA_MODEL_RAW.includes("/")
  ? OLLAMA_MODEL_RAW
  : `scb10x/${OLLAMA_MODEL_RAW}`;
const ARISA_USE_OLLAMA = (process.env.ARISA_USE_OLLAMA || "true") === "true";
const MIN_OLLAMA_TIMEOUT_MS = 120000; // 120s กัน timeout เร็วเกิน

// ===== Arisa System Prompt (Ollama) =====
const ARISA_SYSTEM_PROMPT_GENERAL = `
คุณคือ “อาริศา (Arisa)” ผู้ช่วยของ MedEase

โทนภาษา:
- ภาษาไทย สุภาพ เป็นมิตร น่ารักแบบพอดี
- ใช้คำลงท้าย “นะคะ/ค่ะ”
- ใช้อีโมจิเล็กน้อย 😊✨

หน้าที่:
- ตอบคำถามทั่วไปได้ตามปกติ
- คุยเป็นเพื่อน ให้ข้อมูลที่เป็นความรู้ทั่วไป
- ไม่ต้องพูดเรื่องแพทย์ถ้าไม่เกี่ยวข้อง
- ปิดท้ายด้วยประโยคชวนคุยต่อแบบน่ารัก 1 ประโยค
- ห้ามทักว่า “สวัสดีค่ะ” หรือแนะนำตัวซ้ำทุกข้อความ ให้ตอบตามบริบทข้อความล่าสุดทันที
`.trim();

const ARISA_SYSTEM_PROMPT_HEALTH = `
คุณคือ “อาริศา (Arisa)” ผู้ช่วยสุขภาพของ MedEase

โทนภาษา:
- สุภาพ อ่อนโยน เป็นมิตร น่ารักแบบพอดี
- ใช้อีโมจิเล็กน้อย 😊🌿
- ตอบตรงอาการ/ความรู้สึกที่ผู้ใช้พิมพ์มา ไม่ต้องทักทายหรือแนะนำตัวซ้ำ

กฎสำคัญ:
- ให้คำแนะนำเบื้องต้นเท่านั้น ไม่วินิจฉัยแทนแพทย์
- ห้ามฟันธงโรค หรือสั่งยาอันตราย
- ถ้าอาการรุนแรง ให้แนะนำพบแพทย์

ทุกคำตอบต้องปิดท้ายด้วย:
“⚠️ เป็นคำแนะนำเบื้องต้น หากอาการรุนแรงหรือกังวล ควรพบแพทย์นะคะ”
`.trim();

function isHealthQuestion(text) {
  const t = (text || "").toLowerCase();
  const keywords = [
    "ปวด",
    "เจ็บ",
    "ไข้",
    "ไอ",
    "ไม่สบาย",
    "เวียนหัว",
    "อาเจียน",
    "ท้องเสีย",
    "แน่นหน้าอก",
    "หายใจ",
    "ป่วย",
    "คัน",
    "ผื่น",
  ];
  return keywords.some((k) => t.includes(k));
}

function hasRedFlags(text) {
  const t = (text || "").toLowerCase();
  const flags = [
    "หายใจลำบาก",
    "แน่นหน้าอกรุนแรง",
    "เจ็บหน้าอกรุนแรง",
    "หมดสติ",
    "ชัก",
    "พูดไม่ชัด",
    "อ่อนแรงครึ่งซีก",
    "เลือด",
    "อาเจียนเป็นเลือด",
    "ถ่ายดำ",
  ];
  return flags.some((f) => t.includes(f));
}

function buildArisaSystemPrompt(healthMode = false) {
  return healthMode ? ARISA_SYSTEM_PROMPT_HEALTH : ARISA_SYSTEM_PROMPT_GENERAL;
}

async function callOllamaChat({
  messages,
  timeoutMs = Math.max(
    Number(process.env.OLLAMA_TIMEOUT_MS || 0) || 0,
    MIN_OLLAMA_TIMEOUT_MS
  ),
}) {
  if (typeof fetch !== "function") {
    throw new Error(
      "fetch() ไม่พร้อมใช้งาน: กรุณาใช้ Node.js >= 18 หรือเปิดใช้งาน global fetch"
    );
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Ollama API error: ${res.status} ${res.statusText} ${txt}`
      );
    }

    const data = await res.json();
    const content = data?.message?.content?.trim();
    return content || "ขออภัย อาริศายังตอบไม่ได้ในตอนนี้ค่ะ";
  } finally {
    clearTimeout(t);
  }
}

/**
 * ใช้เป็นจุดเรียก LLM กลาง (ในอนาคตจะสลับไป n8n/RAG ได้ง่าย)
 */
async function arisaLLMReply({ userText, conversationId, userId }) {
  // โหมดง่าย ๆ: สุขภาพ vs คุยทั่วไป (กัน medical warning หลุดไปในคำถามทั่วไป)
  const healthMode = isHealthQuestion(userText);
  const systemPrompt = buildArisaSystemPrompt(healthMode);

  const contextMsgs = await getRecentChatContext(conversationId, 8);

  if (
    contextMsgs.length &&
    contextMsgs[contextMsgs.length - 1]?.role === "user" &&
    contextMsgs[contextMsgs.length - 1]?.content === String(userText)
  ) {
    contextMsgs.pop();
  }

  const profileKey = getArisaProfileKey({ userId, conversationId });
  const profile = await getArisaProfile(profileKey);
  const profileBlock = buildProfileBlock(profile);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "system", content: profileBlock },
    ...contextMsgs,
    { role: "user", content: userText },
  ];

  const answer = await callOllamaChat({
    messages,
    timeoutMs: Math.max(
      Number(process.env.OLLAMA_TIMEOUT_MS || 0),
      MIN_OLLAMA_TIMEOUT_MS
    ),
  });
  const trimmed = String(answer || "").trim();

  // บังคับ warning เฉพาะโหมดสุขภาพ (กันโมเดลลืม)
  if (healthMode) {
    const warningLine =
      "⚠️ เป็นคำแนะนำเบื้องต้น หากอาการรุนแรงหรือกังวล ควรพบแพทย์นะคะ";
    if (!trimmed.includes("⚠️") && !trimmed.includes("คำแนะนำเบื้องต้น")) {
      return trimmed
        ? `${trimmed}

${warningLine}`
        : warningLine;
    }
  }

  return trimmed;
}

// ===== Env (safe logs) =====
console.log("[ENV] N8N_ARISA_URL =", process.env.N8N_ARISA_URL || "(unset)");
console.log("[ENV] OLLAMA_URL    =", process.env.OLLAMA_URL || "(unset)");
console.log("[ENV] OLLAMA_MODEL  =", OLLAMA_MODEL);
console.log(
  "[ENV] CRON_SECRET   =",
  process.env.CRON_SECRET ? "(set)" : "(unset)"
);
console.log(
  "[ENV] DEBUG_SECRET  =",
  process.env.DEBUG_SECRET ? "(set)" : "(unset)"
);

// ===== Init Firebase Admin =====
let FIREBASE_PROJECT_ID = "medeasehosting";

function tryLoadServiceAccountFromRepo() {
  // Priority:
  // 1) apps/api/src/serviceAccountKey.json (legacy)
  // 2) apps/api/secrets/*.json (current)
  // 3) common secrets folders (fallback)
  const candidates = [
    path.join(__dirname, "serviceAccountKey.json"),
    path.join(process.cwd(), "apps", "api", "src", "serviceAccountKey.json"),
    path.join(process.cwd(), "apps", "api", "secrets"),
    path.join(process.cwd(), "apps", "api", "src", "secrets"),
    path.join(process.cwd(), "secrets"),
    path.join(__dirname, "secrets"),
    path.join(__dirname, "..", "secrets"),
  ];

  // direct json path
  for (const p of candidates) {
    try {
      if (p.endsWith(".json") && fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        const obj = JSON.parse(raw);
        if (obj?.project_id && obj?.client_email && obj?.private_key) {
          console.log("[FIREBASE] using service account file:", p);
          return obj;
        }
      }
    } catch {}
  }

  // scan directories
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      const st = fs.statSync(dir);
      if (!st.isDirectory()) continue;

      const files = fs
        .readdirSync(dir)
        .filter((f) => /\.json$/i.test(f) && /(adminsdk|serviceaccount|firebase)/i.test(f));

      for (const f of files) {
        const full = path.join(dir, f);
        try {
          const raw = fs.readFileSync(full, "utf8");
          const obj = JSON.parse(raw);
          if (obj?.project_id && obj?.client_email && obj?.private_key) {
            console.log("[FIREBASE] using service account file:", full);
            return obj;
          }
        } catch {}
      }
    } catch {}
  }

  return null;
}

if (!getApps().length) {
  const serviceAccount = tryLoadServiceAccountFromRepo();

  try {
    if (serviceAccount?.project_id) FIREBASE_PROJECT_ID = serviceAccount.project_id;
  } catch {}

  admin.initializeApp({
    credential: serviceAccount
      ? admin.credential.cert(serviceAccount)
      : admin.credential.applicationDefault(),
    projectId: FIREBASE_PROJECT_ID,
  });

  console.log("[FIREBASE] init admin with", {
    projectId: FIREBASE_PROJECT_ID,
    hasServiceAccount: !!serviceAccount,
  });
}

const db = admin.firestore();

// ================== Phase A: Memory Guardrails ==================
// กัน Firestore ช้าหรือค้าง: ดึง context ไม่ทัน -> fallback เป็น [] ทันที (ไม่ทำให้แชทล่ม)
const MEMORY_FETCH_TIMEOUT_MS = Math.max(
  300,
  Number(process.env.MEMORY_FETCH_TIMEOUT_MS || 0) || 2500
);
const MEMORY_MAX_MESSAGES = Math.min(
  20,
  Math.max(1, Number(process.env.MEMORY_MAX_MESSAGES || 0) || 10)
);
const MEMORY_MAX_CHARS_PER_MSG = Math.min(
  1200,
  Math.max(80, Number(process.env.MEMORY_MAX_CHARS_PER_MSG || 0) || 500)
);

function _clampInt(n, min, max) {
  const x = Number.parseInt(String(n), 10);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function _normalizeMsgText(v, maxChars = MEMORY_MAX_CHARS_PER_MSG) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars).trim() + "…";
}

// ================== Phase A: Safe Memory Writes ==================
// เขียน Firestore แล้ว “ห้ามทำให้แชทล่ม”
// - ถ้าเขียนช้า/พัง ให้ข้าม (fallback) แล้วระบบยังตอบได้
const MEMORY_WRITE_TIMEOUT_MS = Math.max(
  300,
  Number(process.env.MEMORY_WRITE_TIMEOUT_MS || 0) || 2500
);

async function _withTimeout(promise, timeoutMs) {
  return await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs)),
  ]);
}

async function safeWriteMessage({ conversationId, sender, meta, createdAt }) {
  if (!conversationId) return { ok: false, skipped: true };
  try {
    const now = createdAt || admin.firestore.FieldValue.serverTimestamp();
    const payload = {
      conversationId,
      createdAt: now,
      sender: sender || "user",
      meta: meta || {},
    };

    const r = await _withTimeout(db.collection("messages").add(payload), MEMORY_WRITE_TIMEOUT_MS);
    if (r && r.__timeout) {
      console.warn(`[MEMORY][write] messages timeout ${MEMORY_WRITE_TIMEOUT_MS}ms -> skipped`);
      return { ok: false, timeout: true };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[MEMORY][write] messages failed -> skipped:", e?.message || e);
    return { ok: false, error: true };
  }
}

async function safeUpsertConversation({ conversationId, patch }) {
  if (!conversationId) return { ok: false, skipped: true };
  try {
    const r = await _withTimeout(
      db.collection("conversations").doc(conversationId).set(patch || {}, { merge: true }),
      MEMORY_WRITE_TIMEOUT_MS
    );
    if (r && r.__timeout) {
      console.warn(`[MEMORY][write] conversations timeout ${MEMORY_WRITE_TIMEOUT_MS}ms -> skipped`);
      return { ok: false, timeout: true };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[MEMORY][write] conversations failed -> skipped:", e?.message || e);
    return { ok: false, error: true };
  }
}


// ===== Arisa Memory (context) =====
async function getRecentChatContext(conversationId, limit = 8) {
  if (!conversationId) return [];

  // clamp limit กันยิง query หนักเกิน/เผลอส่ง 999
  const safeLimit = _clampInt(limit, 1, MEMORY_MAX_MESSAGES);

  const timeoutPromise = new Promise((resolve) => {
    const t = setTimeout(() => {
      clearTimeout(t);
      resolve({ __timeout: true });
    }, MEMORY_FETCH_TIMEOUT_MS);
  });

  try {
    const queryPromise = db
      .collection("messages")
      .where("conversationId", "==", conversationId)
      .orderBy("createdAt", "desc")
      .limit(safeLimit)
      .get();

    const raced = await Promise.race([queryPromise, timeoutPromise]);

    // timeout -> fallback
    if (raced && raced.__timeout) {
      console.warn(
        `[getRecentChatContext] timeout ${MEMORY_FETCH_TIMEOUT_MS}ms -> fallback empty context`
      );
      return [];
    }

    const snap = raced;
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    rows.reverse(); // เก่า -> ใหม่

    const out = rows
      .map((m) => {
        const raw =
          m.text ??
          m.content ??
          m.message ??
          m.meta?.text ??
          m.meta?.content ??
          null;

        if (!raw) return null;

        const sender = String(
          m.sender ?? m.role ?? m.by ?? m.meta?.by ?? m.meta?.sender ?? ""
        ).toLowerCase();

        const isAssistant =
          sender === "bot" ||
          sender === "assistant" ||
          sender === "arisa" ||
          sender === "ai";

        const content = _normalizeMsgText(raw, MEMORY_MAX_CHARS_PER_MSG);
        if (!content) return null;

        return {
          role: isAssistant ? "assistant" : "user",
          content,
        };
      })
      .filter(Boolean);

    return out;
  } catch (e) {
    console.warn(
      "[getRecentChatContext] fallback empty context:",
      e?.message || e
    );
    return [];
  }
}

// ================== Profile Memory (PATCH: remember important facts) ==================
function getArisaProfileKey({ userId, conversationId }) {
  return userId || conversationId || null;
}

async function upsertArisaProfile(profileKey, patch) {
  if (!profileKey) return;
  await db.collection("arisa_profiles").doc(profileKey).set(
    {
      ...patch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function getArisaProfile(profileKey) {
  if (!profileKey) return null;
  const snap = await db.collection("arisa_profiles").doc(profileKey).get();
  return snap.exists ? snap.data() : null;
}

function buildProfileBlock(profile) {
  const name = profile?.name ? String(profile.name) : "";
  const hasExamSoon = profile?.hasExamSoon === true;

  const base = name
    ? `โปรไฟล์ผู้ใช้ (เชื่อถือได้):\n- ชื่อผู้ใช้: ${name}\n- พรุ่งนี้มีสอบ: ${
        hasExamSoon ? "ใช่" : "ไม่ทราบ"
      }\n`
    : `โปรไฟล์ผู้ใช้ (ยังไม่ทราบชื่อ)\n- พรุ่งนี้มีสอบ: ${
        hasExamSoon ? "ใช่" : "ไม่ทราบ"
      }\n`;

  // ค้อนทุบให้ “จำชื่อ” + กันการเดา/ถามซ้ำ
  const rule = [
    "กฎ:",
    "- อาริศาเป็นชื่อของผู้ช่วย ไม่ใช่ชื่อผู้ใช้",
    "- ถ้ารู้ชื่อผู้ใช้แล้ว ห้ามถามชื่อซ้ำ และห้ามเดาว่าชื่อผู้ใช้คือ “อาริศา”",
    "- ถ้าผู้ใช้ถามว่า “จำชื่อฉันได้ไหม” ให้ตอบตรง ๆ ว่าชื่ออะไร",
    "- เวลาเหมาะสมให้เรียกชื่อผู้ใช้ในคำตอบแบบเป็นธรรมชาติ",
  ].join("\n");

  return base + "\n" + rule;
}

function extractProfileFacts(text) {
  const t = String(text || "").trim();
  const facts = {};

  // ชื่อ: "ฉันชื่อบอล" / "ฉันชื่อว่า บอล" / "ฉันชื่อว่าบอล" / "ผมชื่อบอล"
  // - รองรับคำว่า "ว่า" แบบมี/ไม่มีเว้นวรรค
  // - จำกัดความยาวชื่อเพื่อกันจับมั่ว
  const mName = t.match(/^(ฉัน|ผม|หนู|เรา)?\s*ชื่อ(?:\s*ว่า)?\s*([\p{L}0-9._-]{2,30})/u);
  if (mName) {
    const raw = String(mName[2] || "").trim();
    facts.name = raw.replace(/^ว่า/u, "").trim();
  }

  // สอบ: "พรุ่งนี้มีสอบ" / "พรุ่งนี้สอบ" / "มีสอบ"
  if (/พรุ่งนี้.*สอบ|พรุ่งนี้สอบ|มีสอบ/.test(t)) facts.hasExamSoon = true;

  return facts;
}

// ===== Arisa Symptom Session (Firestore) =====
async function getArisaSession(conversationId) {
  if (!conversationId) return null;
  const ref = db.collection("arisa_sessions").doc(conversationId);
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

async function setArisaSession(conversationId, patch) {
  if (!conversationId) return;
  const ref = db.collection("arisa_sessions").doc(conversationId);
  await ref.set(
    { ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function clearArisaSession(conversationId) {
  if (!conversationId) return;
  await db
    .collection("arisa_sessions")
    .doc(conversationId)
    .delete()
    .catch(() => {});
}

// ===== Symptom flow (ถามทีละข้อ) =====
async function handleSymptomFlow({ conversationId, userText, userId }) {
  // red flag -> จบทันที
  if (hasRedFlags(userText)) {
    await clearArisaSession(conversationId);
    return `อาริศาเป็นห่วงนะคะ 🥺 อาการที่เล่ามา “เข้าข่ายสัญญาณอันตราย” แนะนำให้ไปโรงพยาบาล/โทรฉุกเฉินทันทีค่ะ

⚠️ เป็นคำแนะนำเบื้องต้น หากอาการรุนแรงหรือกังวล ควรพบแพทย์นะคะ`;
  }

  let s =
    (await getArisaSession(conversationId)) || {
      mode: "symptom",
      step: "ask_symptom",
      slots: {},
    };

  // ผู้ใช้ยกเลิก/เปลี่ยนเรื่อง
  if (
    ["ยกเลิก", "ไม่แล้ว", "พอแล้ว", "เปลี่ยนเรื่อง"].some((k) =>
      (userText || "").includes(k)
    )
  ) {
    await clearArisaSession(conversationId);
    return `ได้เลยค่ะ 😊 ถ้าอยากให้ช่วยประเมินอาการใหม่เมื่อไหร่ บอกอาริศาได้เสมอนะคะ`;
  }

  // STEP: ask_symptom
  if (s.step === "ask_symptom") {
    s.slots.symptom = userText;
    s.step = "ask_age";
    await setArisaSession(conversationId, s);
    return `รับทราบค่ะ 😊 อาริศาขอถามเพิ่มนิดนึงนะคะ

1) อายุเท่าไหร่คะ (เช่น 20)
(พิมพ์เป็นตัวเลขได้เลยค่ะ)`;
  }

  // STEP: ask_age
  if (s.step === "ask_age") {
    const age = parseInt(userText, 10);
    if (Number.isNaN(age) || age <= 0 || age > 120) {
      return `ขออาริศาเป็น “ตัวเลขอายุ” หน่อยนะคะ เช่น 20 😊`;
    }
    s.slots.age = age;
    s.step = "ask_duration";
    await setArisaSession(conversationId, s);
    return `ขอบคุณค่ะ ✨

2) เป็นมานานแค่ไหนแล้วคะ (เช่น 6 ชั่วโมง / 2 วัน)`;
  }

  // STEP: ask_duration
  if (s.step === "ask_duration") {
    s.slots.duration = userText;
    s.step = "ask_severity";
    await setArisaSession(conversationId, s);
    return `โอเคเลยค่ะ 🌿

3) ความรุนแรงประมาณไหนคะ (1–10)
1 = นิดเดียว, 10 = รุนแรงมาก`;
  }

  // STEP: ask_severity
  if (s.step === "ask_severity") {
    const sev = parseInt(userText, 10);
    if (Number.isNaN(sev) || sev < 1 || sev > 10) {
      return `ขอเป็นตัวเลข 1–10 นะคะ 😊`;
    }
    s.slots.severity = sev;
    s.step = "final";
    await setArisaSession(conversationId, s);
  }

  // FINAL
  const slots = s.slots || {};
  const prompt = `
ผู้ใช้มีอาการ: ${slots.symptom || "-"}
อายุ: ${slots.age ?? "-"}
ระยะเวลา: ${slots.duration || "-"}
ความรุนแรง: ${slots.severity ?? "-"}/10

ให้ตอบเป็น “คำแนะนำเบื้องต้น” เท่านั้น ห้ามฟันธงโรค
จัดรูปแบบ:
- สรุปสิ่งที่เข้าใจ (1 บรรทัด)
- ดูแลตัวเองเบื้องต้น 3 ข้อ (ปลอดภัย)
- สัญญาณอันตราย/ควรไปพบแพทย์เมื่อไร (bullet)
- ปิดท้ายคำเตือนเสมอ
`.trim();

  const contextMsgs = await getRecentChatContext(conversationId, 8);

  const profileKey = getArisaProfileKey({ userId, conversationId });
  const profile = await getArisaProfile(profileKey);
  const profileBlock = buildProfileBlock(profile);

  const reply = await callOllamaChat({
    messages: [
      { role: "system", content: ARISA_SYSTEM_PROMPT_HEALTH },
      { role: "system", content: profileBlock },
      ...contextMsgs,
      { role: "user", content: prompt },
    ],
    timeoutMs: Math.max(
      Number(process.env.OLLAMA_TIMEOUT_MS || 0),
      MIN_OLLAMA_TIMEOUT_MS
    ),
  });

  await clearArisaSession(conversationId);
  return reply || `ขออภัยค่ะ อาริศาตอบไม่ได้ชั่วคราว`;
}

// ===== Public base URL สำหรับลิงก์ดาวน์โหลดใบรับรอง =====
const CERT_BASE_URL =
  process.env.CERT_BASE_URL || "https://3c2d15baa2ed.ngrok-free.app";

// 🔐 Secret สำหรับ cron (PATCH: no default hardcoded)
const CRON_SECRET = process.env.CRON_SECRET || "";

// ===== LINE config =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.warn(
    "[LINE] Missing channelAccessToken/channelSecret in environment variables"
  );
}

// ===== Express app =====
const app = express();
app.set("trust proxy", 1);

// ===== CORS (harden) =====
// - allowlist origins for browser calls
// - for non-browser/server calls (no Origin header) allow through
const ALLOWED_ORIGINS = new Set(
  (
    process.env.CORS_ORIGINS ||
    "https://medeasehosting.web.app,http://localhost:5000,http://127.0.0.1:5000"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const hasOrigin = !!origin;

  // Allow requests without Origin (server-to-server / curl)
  if (!hasOrigin) return next();

  // Allow if in allowlist
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-CRON-SECRET, ngrok-skip-browser-warning"
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  }

  // Reject browser cross-site requests not allowlisted:
  if (hasOrigin && !ALLOWED_ORIGINS.has(origin)) {
    if (req.method === "OPTIONS") return res.status(204).end();
    return res.status(403).json({ ok: false, error: "CORS blocked" });
  }

  return next();
}
app.use(corsMiddleware);

// ===== LINE Client =====
const client = new Client(config);
export const lineClient = client;

// ===== Helpers =====
function getConversationIdFromLineEvent(event) {
  const src = event?.source || {};
  return src.groupId || src.roomId || src.userId || "unknown";
}

async function _getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  const mod = await import("node-fetch");
  return mod.default;
}

async function findClinicsOSM(lat, lon, radiusM = 3000) {
  const query = `
[out:json][timeout:20];
(
  node["amenity"="hospital"](around:${radiusM},${lat},${lon});
  node["amenity"="clinic"](around:${radiusM},${lat},${lon});
  node["amenity"="doctors"](around:${radiusM},${lat},${lon});
);
out center 10;
`.trim();

  const fetch = await _getFetch();
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: query,
  });

  if (!res.ok) throw new Error("Overpass API error");

  const data = await res.json();
  const items = (data.elements || [])
    .slice(0, 5)
    .map((e) => {
      const name = e.tags?.name || "ไม่ทราบชื่อ";
      const elat = e.lat;
      const elon = e.lon;
      const map = `https://www.google.com/maps/search/?api=1&query=${elat},${elon}`;
      return { name, lat: elat, lon: elon, map };
    });

  return items;
}

// ===== N8N LLM =====
async function callArisaLLM({ userId, text, conversationId }) {
  const url = process.env.N8N_ARISA_URL;
  if (!url) throw new Error("Missing N8N_ARISA_URL in .env");

  const fetch = await _getFetch();

  const controller = new AbortController();
  const timeoutMs = 15_000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // PATCH(Profile/Context): send extra memory fields to n8n (safe even if ignored)
    let contextMsgs = [];
    let profileText = "";
    try {
      contextMsgs = await getRecentChatContext(conversationId, 10);
    } catch (_) {}
    try {
      const profileKey = getArisaProfileKey({ userId, conversationId });
      const profile = await getArisaProfile(profileKey);
      profileText = buildProfileBlock(profile);
    } catch (_) {}

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(process.env.N8N_ARISA_TOKEN
          ? { "x-arisa-token": process.env.N8N_ARISA_TOKEN }
          : {}),
      },
      body: JSON.stringify({ userId, text, conversationId, profileText, contextMsgs }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`N8N error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return (data?.text || data?.reply || "").toString().trim();
  } finally {
    clearTimeout(t);
  }
}

// ===== Ollama fallback (PATCH: guardrails) =====
async function callOllamaLLM({ userId, text, conversationId }) {
  const healthMode = isHealthQuestion(text);
  const systemPrompt = buildArisaSystemPrompt(healthMode);

  const base = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
  const modelRaw =
    process.env.OLLAMA_MODEL || "scb10x/llama3.2-typhoon2-3b-instruct";
  const model = modelRaw.includes("/") ? modelRaw : `scb10x/${modelRaw}`;
  const url = `${base}/api/chat`;

  const fetch = await _getFetch();

  const controller = new AbortController();
  const timeoutMs = 20_000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const contextMsgs = await getRecentChatContext(conversationId, 8);

    // กันข้อความซ้ำ: บางกรณีบันทึกข้อความผู้ใช้ลง Firestore แล้วก่อนเรียก LLM
    if (
      contextMsgs.length &&
      contextMsgs[contextMsgs.length - 1]?.role === "user" &&
      contextMsgs[contextMsgs.length - 1]?.content === String(text)
    ) {
      contextMsgs.pop();
    }

    const profileKey = getArisaProfileKey({ userId, conversationId });
    const profile = await getArisaProfile(profileKey);
    const profileText = buildProfileBlock(profile);

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: profileText },
      ...contextMsgs,
      { role: "user", content: text },
    ];

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama error ${res.status}: ${body}`);
    }

    const data = await res.json();
    let out = (data?.message?.content || "").toString().trim();

    // hard limit for LINE safety
    if (out.length > 1200)
      out = out.slice(0, 1200).trim() + "\n\n(ตัดให้สั้นลงเพื่อส่งในแชตค่ะ)";
    // LINE message hard limit ~5000 chars (safe margin)
    if (out.length > 4500)
      out = out.slice(0, 4500).trim() + "\n\n(ตัดให้สั้นลงเพื่อส่งในแชตค่ะ)";
    // บังคับ warning เฉพาะโหมดสุขภาพ (กันโมเดลลืม)
    if (healthMode) {
      const warningLine =
        "⚠️ เป็นคำแนะนำเบื้องต้น หากอาการรุนแรงหรือกังวล ควรพบแพทย์นะคะ";
      if (!out.includes("⚠️") && !out.includes("คำแนะนำเบื้องต้น")) {
        out = out
          ? `${out}

${warningLine}`
          : warningLine;
      }
    }

    return out;
  } finally {
    clearTimeout(t);
  }
}

// ===== Arisa KB (Vector Search) =====
// System KB (FAQ/ระบบ) ใช้ collection เดิม arisa_kb_chunks (มี vector index READY)
const ARISA_KB_COLLECTION_SYSTEM = process.env.ARISA_KB_COLLECTION || "arisa_kb_chunks";
const ARISA_KB_VERSION_SYSTEM = process.env.ARISA_KB_VERSION_SYSTEM || "th_v1";

// ===== KB sanity check (startup) =====
// Helps debug cases where KB exists but retrieval returns 0 hits.
// Runs after KB constants are initialized.
//
// NOTE: Firestore Vector field returns a VectorValue (not an Array).
// We treat embedding as "present" if it is:
// - Array (legacy) OR
// - has .toArray() OR
// - has .values (array-like)
function _hasVectorValue(v) {
  try {
    if (!v) return false;
    if (Array.isArray(v)) return v.length > 8;
    if (typeof v.toArray === "function") {
      const a = v.toArray();
      return Array.isArray(a) && a.length > 8;
    }
    if (Array.isArray(v.values)) return v.values.length > 8;
    return typeof v === "object"; // fallback: vector type
  } catch {
    return false;
  }
}

setTimeout(async () => {
  try {
    const snap = await db
      .collection(ARISA_KB_COLLECTION_SYSTEM)
      .where("kbVersion", "==", ARISA_KB_VERSION_SYSTEM)
      .limit(3)
      .get();

    const hasAny = !snap.empty;
    let hasEmbedding = false;

    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (_hasVectorValue(d.embedding)) hasEmbedding = true;
    });

    console.log(
      `[KB_CHECK] collection=${ARISA_KB_COLLECTION_SYSTEM} kbVersion=${ARISA_KB_VERSION_SYSTEM} hasAny=${hasAny} sample=${snap.size} hasEmbedding=${hasEmbedding}`
    );
  } catch (e) {
    console.warn("[KB_CHECK] failed:", e?.message || e);
  }
}, 0);



// Health KB (อาการ/ความรู้สุขภาพ) แยก collection เพื่อกันปน
const ARISA_KB_COLLECTION_HEALTH = process.env.ARISA_KB_COLLECTION_HEALTH || "arisa_kb_chunks_health";
const ARISA_KB_VERSION_HEALTH = process.env.ARISA_KB_VERSION_HEALTH || "th_v1_health";
const ARISA_KB_VERSION = process.env.ARISA_KB_VERSION || "th_v1";

const ARISA_EMBED_MODEL =
  process.env.ARISA_EMBED_MODEL || "gemini-embedding-001";
const ARISA_EMBED_DIM = Number(process.env.ARISA_EMBED_DIM || "768");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// If Gemini key is not available, use Ollama embeddings for KB query as well
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

async function geminiEmbedOne({ text, taskType = "RETRIEVAL_QUERY" }) {
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
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        lastErr = new Error(`Gemini embed failed: ${res.status} ${t}`);
        continue;
      }

      const json = await res.json();
      const vec = json?.embedding?.values;

      if (!Array.isArray(vec)) {
        lastErr = new Error("Gemini embed response missing embedding.values[]");
        continue;
      }
      if (vec.length !== ARISA_EMBED_DIM) {
        lastErr = new Error(
          `Embedding dimension mismatch: expected ${ARISA_EMBED_DIM}, got ${vec.length}`
        );
        continue;
      }
      return vec;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Gemini embed failed");
}


async function ollamaEmbedOneForKbQuery({ text }) {
  const fetch = await _getFetch();
  const url = `${(process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "")}/api/embeddings`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: String(text || "") }),
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

async function arisaKbKeywordFallback(queryText, limit = 5, collectionName, kbVersion) {
  try {
    // No special indexes required: fetch a small pool by kbVersion then score locally.
    const q = String(queryText || "").toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 16);

    const snap = await db
      .collection(collectionName)
      .where("kbVersion", "==", kbVersion)
      .limit(60)
      .get();

    const pool = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const text = String(d.text || "").toLowerCase();
      const title = String(d.title || "").toLowerCase();
      const hay = `${title} ${text}`;
      let score = 0;
      for (const t of tokens) {
        if (!t) continue;
        if (hay.includes(t)) score += 1;
      }
      pool.push({
        id: doc.id,
        ...d,
        score,
      });
    });

    pool.sort((a, b) => (b.score || 0) - (a.score || 0));
    const hits = pool.filter((h) => (h.score || 0) > 0).slice(0, limit);

    return hits.map((h) => ({
      id: h.id,
      title: h.title || "",
      topic: h.topic || "",
      severity: h.severity || "info",
      tags: Array.isArray(h.tags) ? h.tags : [],
      text: h.text || "",
      redFlags: Array.isArray(h.redFlags) ? h.redFlags : [],
      distance: undefined,
      score: h.score,
    }));
  } catch (e) {
    return [];
  }
}


async function arisaKbKeywordFallbackLoose(queryText, limit = 5, collectionName, preferredKbVersion = null) {
  try {
    const q = String(queryText || "").toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 16);

    // Pull a small pool without kbVersion filter (helps when kbVersion mismatch / old seeds)
    const snap = await db.collection(collectionName).limit(120).get();

    const pool = [];
    const versionCount = new Map();

    snap.forEach((doc) => {
      const d = doc.data() || {};
      const kbv = String(d.kbVersion || "").trim();
      if (kbv) versionCount.set(kbv, (versionCount.get(kbv) || 0) + 1);

      const text = String(d.text || "").toLowerCase();
      const title = String(d.title || "").toLowerCase();
      const hay = `${title} ${text}`;

      let score = 0;

      // Prefer matches on preferredKbVersion (soft boost, not hard filter)
      if (preferredKbVersion && kbv === preferredKbVersion) score += 1.5;

      for (const t of tokens) {
        if (!t) continue;
        if (hay.includes(t)) score += 1;
      }

      pool.push({
        id: doc.id,
        ...d,
        score,
        _kbv: kbv,
      });
    });

    pool.sort((a, b) => (b.score || 0) - (a.score || 0));
    const hits = pool.filter((h) => (h.score || 0) > 0).slice(0, limit);

    // debug hint: if preferredKbVersion not present at all, log it once
    try {
      if (preferredKbVersion && !versionCount.has(preferredKbVersion)) {
        console.warn(
          `[KB_RAG] kbVersion mismatch? preferred=${preferredKbVersion} availableVersions=${Array.from(versionCount.keys()).slice(0, 6).join(",") || "(none)"}`
        );
      }
    } catch {}

    return hits.map((h) => ({
      id: h.id,
      title: h.title || "",
      topic: h.topic || "",
      severity: h.severity || "info",
      tags: Array.isArray(h.tags) ? h.tags : [],
      text: h.text || "",
      redFlags: Array.isArray(h.redFlags) ? h.redFlags : [],
      distance: undefined,
      score: h.score,
      kbVersion: h._kbv || h.kbVersion || "",
      source: h.source || "",
      updatedAt: h.updatedAt || "",
    }));
  } catch (e) {
    return [];
  }
}

// ===== KB Direct Lookup (fast path / safety net) =====
// ใช้เมื่อ vector search คืน 0 ทั้งที่ KB มีอยู่ (กันพังระหว่างช่วงปรับ index/embedding)
// จำกัดเฉพาะ system FAQ ที่รู้ docId ชัดเจน
async function arisaKbDirectDocLookup(queryText, collectionName, kbVersion) {
  try {
    const q = String(queryText || "").trim();
    const low = q.toLowerCase();

    let docId = null;
    if (/medease\s*คือ\s*อะไร/i.test(q) || low.includes("medease คืออะไร")) docId = `${kbVersion}__faq-001__000`;
    else if (/arisa\s*คือ\s*ใคร/i.test(q) || low.includes("arisa คือใคร") || /อริศา\s*คือ\s*ใคร/.test(q)) docId = `${kbVersion}__faq-002__000`;
    else if (/ฟีเจอร์หลัก.*medease/.test(q) || low.includes("ฟีเจอร์หลักของ medease")) docId = `${kbVersion}__faq-004__000`;

    if (!docId) return null;

    const snap = await db.collection(collectionName).doc(docId).get();
    if (!snap.exists) return null;

    const d = snap.data() || {};
    return {
      id: snap.id,
      title: d.title || "",
      topic: d.topic || "",
      severity: d.severity || "info",
      tags: Array.isArray(d.tags) ? d.tags : [],
      text: d.text || "",
      redFlags: Array.isArray(d.redFlags) ? d.redFlags : [],
      distance: 0,
      source: d.source || "",
      updatedAt: d.updatedAt || "",
    };
  } catch {
    return null;
  }
}

async function arisaKbVectorSearch(
  queryText,
  limit = 5,
  collectionName = ARISA_KB_COLLECTION_SYSTEM,
  kbVersion = ARISA_KB_VERSION_SYSTEM
) {
  try {

    // fast path: known FAQ docIds (helps when vector index/embedding hiccups)
    const direct = await arisaKbDirectDocLookup(queryText, collectionName, kbVersion);
    if (direct) return [direct];

    const vec = GEMINI_API_KEY
      ? await geminiEmbedOne({ text: queryText, taskType: "RETRIEVAL_QUERY" })
      : await ollamaEmbedOneForKbQuery({ text: queryText });

    const base = db.collection(collectionName).where("kbVersion", "==", kbVersion);

    const q = base.findNearest("embedding", vec, {
      limit,
      distanceMeasure: "COSINE",
      distanceResultField: "distance",
    });

    const snap = await q.get();

    const hits = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      let dist;
      try {
        dist = typeof doc.get === "function" ? doc.get("distance") : undefined;
      } catch (_) {}
      if (typeof dist !== "number") dist = typeof d.distance === "number" ? d.distance : undefined;

      hits.push({
        id: doc.id,
        title: d.title || "",
        topic: d.topic || "",
        severity: d.severity || "info",
        tags: Array.isArray(d.tags) ? d.tags : [],
        text: d.text || "",
        redFlags: Array.isArray(d.redFlags) ? d.redFlags : [],
        distance: dist,
        source: d.source || "",
        updatedAt: d.updatedAt || "",
      });
    });

    

    // If vector search returns empty (often due to kbVersion mismatch or missing embeddings),
    // fall back to lightweight keyword search (same kbVersion -> then loose).
    if (!hits.length) {
      const kw1 = await arisaKbKeywordFallback(queryText, limit, collectionName, kbVersion);
      if (kw1 && kw1.length) return kw1;

      const kw2 = await arisaKbKeywordFallbackLoose(queryText, limit, collectionName, kbVersion);
      if (kw2 && kw2.length) return kw2;
    }
return hits;
  } catch (e) {
    const msg = String((typeof getErrMsg === "function" ? getErrMsg(e) : "") || e?.message || e || "");
    if (msg.includes("FAILED_PRECONDITION") && msg.includes("vector index")) {
      console.warn("[KB_RAG] vector index missing -> keyword fallback");
      return await arisaKbKeywordFallback(queryText, limit, collectionName, kbVersion);
    }
    return [];
  }
}

// ===== PATCH: KB short answer (dynamic minimal) =====
function _pickKbSnippet(text, maxLen = 160) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= maxLen ? t : t.slice(0, maxLen).trim() + "…";
}

function buildArisaKbReplyShort(userText, hits) {
  if (!hits?.length) return null;

  const top = hits[0] || {};
  const topic = (top.topic || "").toLowerCase();
  const tags = (top.tags || []).map((x) => String(x).toLowerCase());
  const seed = `${topic} ${tags.join(" ")} ${String(top.title || "").toLowerCase()}`;


  // If KB hit is about the system/FAQ, answer directly (avoid symptom template)
  const SYS_TOPICS = new Set([
    "about",
    "features",
    "appointments",
    "certificates",
    "news",
    "privacy",
    "troubleshoot",
    "study",
    "safety",
  ]);
  if (SYS_TOPICS.has(topic)) {
    const snippet = _pickKbSnippet(top.text, 420);
    const lines = [];
    lines.push(`${top.title || "ข้อมูลจาก MedEase"}`);
    if (snippet) lines.push(`• ${snippet}`);
    lines.push("");
    lines.push(`อ้างอิง: ${top.id || top.sourceId || "kb"}`);
    return lines.join("\n");
  }

  // very small template chooser
  const isSoreThroat =
    /เจ็บคอ|คออักเสบ|ไข้หวัด|หวัด|ไอ|น้ำมูก|sore|throat|flu|cold/.test(
      seed + " " + userText
    );
  const isDiarrhea =
    /ท้องเสีย|ถ่ายเหลว|อาหารเป็นพิษ|อุจจาระ|diarrhea|food poison/.test(
      seed + " " + userText
    );
  const isHeadache =
    /ปวดหัว|ไมเกรน|เวียนหัว|หัว|headache|migraine|dizzy/.test(
      seed + " " + userText
    );

  const lines = [];
  lines.push("อาริศาช่วยสรุปให้แบบสั้น ๆ นะคะ 🩺");
  lines.push("");

  lines.push("✅ ทำตอนนี้ก่อน");

  if (isDiarrhea) {
    lines.push("• จิบน้ำเกลือแร่ (ORS) บ่อย ๆ + ดื่มน้ำสะอาด");
    lines.push("• กินอาหารอ่อน ๆ เลี่ยงนม/ของมัน/เผ็ด/แอลกอฮอล์");
    lines.push("• สังเกตความถี่การถ่าย + อาการขาดน้ำ (ปากแห้ง เวียนหัว ปัสสาวะน้อย)");
  } else if (isHeadache) {
    lines.push("• พักผ่อนในที่เงียบ ดื่มน้ำให้พอ");
    lines.push("• เลี่ยงจอ/แสงจ้า และจดว่าปวดตำแหน่งไหน นานแค่ไหน");
    lines.push("• ถ้ามีความเครียด/นอนน้อย ให้ลองพักและจัดเวลานอน");
  } else if (isSoreThroat) {
    lines.push("• ดื่มน้ำอุ่น/น้ำเปล่าเยอะ ๆ พักผ่อน");
    lines.push("• กลั้วคอน้ำเกลืออุ่น + เลี่ยงควัน/บุหรี่/แอลกอฮอล์");
    lines.push("• วัดไข้และจด “อุณหภูมิ + เวลา”");
    lines.push("• เจ็บคอมากให้พักเสียง กินอาหารอ่อน ๆ");
  } else {
    lines.push("• พักผ่อน ดื่มน้ำให้พอ และจดอาการ/เวลาเริ่มเป็น");
    lines.push("• เลี่ยงกิจกรรมหนัก และสังเกตว่าอาการดีขึ้นหรือแย่ลง");
  }

  lines.push("");
  lines.push("🚨 ไปพบแพทย์/รพ. ถ้ามีข้อใดข้อหนึ่ง");

  const rf = (top.redFlags || [])
    .slice(0, 3)
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (rf.length) {
    rf.forEach((x) => lines.push(`• ${x}`));
  } else {
    lines.push("• หายใจลำบาก / เจ็บหน้าอก / ซึมลง");
    lines.push("• อาเจียนรุนแรง/กินดื่มไม่ได้/ขาดน้ำ");
    lines.push("• ไข้สูงมาก หรือเป็นต่อเนื่องหลายวัน");
  }

  const snippet = _pickKbSnippet(top.text, 170);
  lines.push("");
  lines.push(
    `📚 จากคลังความรู้: ${
      snippet ? `“${snippet}”` : "มีคำแนะนำเบื้องต้นตามอาการค่ะ"
    }`
  );

  lines.push("");
  lines.push(`อ้างอิง: ${top.id || top.sourceId || "kb"}`);

  return lines.join("\n");
}

async function logKbRagToFirestore({
  conversationId,
  userId,
  queryText,
  hits,
  answer,
  collectionName,
}) {
  try {
    await db.collection("arisa_kb_logs").add({
      conversationId: conversationId || null,
      userId: userId || null,
      kbVersion: ARISA_KB_VERSION,
      collection: collectionName || ARISA_KB_COLLECTION_SYSTEM,
      queryText,
      topHits: (hits || []).slice(0, 5).map((h) => ({
        id: h.id,
        title: h.title,
        topic: h.topic,
        severity: h.severity,
        distance: h.distance ?? null,
      })),
      answerPreview: String(answer || "").slice(0, 500),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn("[KB_LOG] failed:", e?.message || e);
  }
}

// ===== Text reply helpers + log ลง Firestore =====
async function logBotMessage(conversationId, text, meta = {}) {
  if (!conversationId) return;

  const now = admin.firestore.FieldValue.serverTimestamp();

  // ensure logText is always defined (avoid ReferenceError)
  const logText = String(text || meta?.text || meta?.message || "");

  // 1) write message (never throw)
  await safeWriteMessage({
    conversationId,
    sender: "bot",
    createdAt: now,
    meta: {
      toolUsed: "chatgpt",
      text,
      ...meta,
    },
  });

  // 2) update conversation pointer (never throw)
  await safeUpsertConversation({
    conversationId,
    patch: {
      lastMessageAt: now,
      updatedAt: now,
      lastMessageText: logText.slice(0, 120),
    },
  });
}


// ===== Phase A: Outgoing Text Normalizer (anti-dup + anti-boilerplate) =====
function _dedupeConsecutive(items) {
  const out = [];
  for (const it of items) {
    const last = out.length ? out[out.length - 1] : null;
    if (last === it) continue;
    out.push(it);
  }
  return out;
}

function dedupeRepeatedText(rawText) {
  const t = String(rawText || "").trim();
  if (!t) return t;

  // Whole-text duplication (A + A)
  const half = Math.floor(t.length / 2);
  const a = t.slice(0, half).trim();
  const b = t.slice(half).trim();
  if (a && b && a === b) return a;

  // Paragraph-level global dedupe (keep first)
  const paras = t.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const kept = [];

  for (const p of paras) {
    const key = p.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // within paragraph: dedupe consecutive identical lines
    const lines = p.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    kept.push(_dedupeConsecutive(lines).join("\n"));
  }

  return kept.join("\n\n").trim();
}

// Central normalizer before sending to LINE
function normalizeOutgoingText({ conversationId, text, healthMode = false }) {
  let out = String(text || "").trim();
  if (!out) return out;
  // Never show internal tags to user
  out = out.replace(/^\[Flex\]\s*/i, "");

  // remove repeated boilerplate (general only) if helper exists
  try {
    if (typeof stripRepeatedBoilerplate === "function") {
      out = stripRepeatedBoilerplate({ conversationId, text: out, healthMode });
    }
  } catch {}

  // dedupe duplicated blocks/paras/lines anywhere
  out = dedupeRepeatedText(out);

  return out;
}
async function reply(replyToken, text, conversationId = null, meta = {}) {
  const cleanedText = normalizeOutgoingText({ conversationId, text, healthMode: false });
  const msg = { type: "text", text: cleanedText };
  await client.replyMessage(replyToken, msg);

  if (conversationId) {
    await logBotMessage(conversationId, cleanedText, meta);
  }
}

async function replyQuick(replyToken, text, items, conversationId = null, meta = {}) {
  const cleanedText = normalizeOutgoingText({ conversationId, text, healthMode: false });
  const msg = {
    type: "text",
    text: cleanedText,
    quickReply: {
      items: items.map((it) => ({
        type: "action",
        action: { type: "message", label: it.label, text: it.text },
      })),
    },
  };

  await client.replyMessage(replyToken, msg);

  if (conversationId) {
    await logBotMessage(conversationId, cleanedText, { ...meta, kind: "quickReply" });
  }
}

async function replyFlex(replyToken, flexContents, conversationId = null, meta = {}) {
  await client.replyMessage(replyToken, flexContents);

  if (conversationId) {
    const summary =
      meta.text ||
      (flexContents.altText ? `[Flex] ${flexContents.altText}` : "[Flex] ตอบกลับจากระบบ");
    await logBotMessage(conversationId, summary, { ...meta, kind: "flex" });
  }
}

// ===== Date helpers (Asia/Bangkok midnight) =====
function parseThaiDateToBangkokMidnight(text) {
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  let [, dd, mm, yyyy] = m;
  dd = dd.padStart(2, "0");
  mm = mm.padStart(2, "0");
  const dateKey = `${yyyy}-${mm}-${dd}`;
  const utcMs = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), -7, 0, 0);
  const ts = admin.firestore.Timestamp.fromMillis(utcMs);
  return { dateKey, ts };
}

function formatDateTH(dateKey) {
  const [y, m, d] = dateKey.split("-");
  return `${d}/${m}/${y}`;
}

function formatThaiDate(date) {
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "full",
    timeZone: "Asia/Bangkok",
  }).format(date);
}

function formatTimeRangeTH(startAt, endAt) {
  const toBangkok = (ts) =>
    ts.toDate().toLocaleTimeString("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Bangkok",
    });

  const startStr = toBangkok(startAt);
  const endStr = endAt ? toBangkok(endAt) : null;

  if (!endStr) return `${startStr} น.`;
  return `${startStr}–${endStr} น.`;
}

/** เวลา now ตามโซน Asia/Bangkok */
function getBangkokNow() {
  const now = new Date();
  const bkkString = now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" });
  return new Date(bkkString);
}

/** แปลง Date เป็น "d ม.ค. 2568" */
function formatDateThaiFromDate(date) {
  const d = date.getDate();
  const months = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
  ];
  const m = months[date.getMonth()];
  const year = date.getFullYear() + 543;
  return `${d} ${m} ${year}`;
}

// ===== Flex UI: Doctor Schedule Card =====
const DEFAULT_DOCTOR_PORTAL_URL = (
  process.env.DOCTOR_PORTAL_URL || "https://medeasehosting.web.app/doctor-my-schedule.html"
).replace(/\/+$/, "");

function shiftTypeToThai(shiftType) {
  if (!shiftType) return "-";
  const v = String(shiftType).toLowerCase();
  if (v === "morning") return "เวรเช้า";
  if (v === "afternoon") return "เวรบ่าย";
  if (v === "night") return "เวรดึก";
  return v === "other" ? "เวรอื่นๆ" : shiftType;
}

function safeText(v, fallback = "-") {
  const s = (v ?? "").toString().trim();
  return s ? s : fallback;
}

function buildDoctorShiftBubble({
  title = "แจ้งตารางเวรแพทย์",
  doctorName = "-",
  dateText = "-",
  timeText = "-",
  shiftType = "-",
  location = "-",
  note = "-",
  status = "-",
  buttonUrl = DEFAULT_DOCTOR_PORTAL_URL,
  buttonLabel = "ดูตารางงานทั้งหมด",
}) {
  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: title, weight: "bold", size: "md", wrap: true },
        {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          contents: [
            {
              type: "box",
              layout: "baseline",
              spacing: "sm",
              contents: [
                { type: "text", text: "แพทย์", size: "sm", color: "#666666", flex: 3 },
                { type: "text", text: safeText(doctorName), size: "sm", wrap: true, flex: 7 },
              ],
            },
            {
              type: "box",
              layout: "baseline",
              spacing: "sm",
              contents: [
                { type: "text", text: "วันที่", size: "sm", color: "#666666", flex: 3 },
                { type: "text", text: safeText(dateText), size: "sm", wrap: true, flex: 7 },
              ],
            },
            {
              type: "box",
              layout: "baseline",
              spacing: "sm",
              contents: [
                { type: "text", text: "เวลา", size: "sm", color: "#666666", flex: 3 },
                { type: "text", text: safeText(timeText), size: "sm", wrap: true, flex: 7 },
              ],
            },
            {
              type: "box",
              layout: "baseline",
              spacing: "sm",
              contents: [
                { type: "text", text: "ประเภทเวร", size: "sm", color: "#666666", flex: 3 },
                { type: "text", text: safeText(shiftTypeToThai(shiftType)), size: "sm", wrap: true, flex: 7 },
              ],
            },
            {
              type: "box",
              layout: "baseline",
              spacing: "sm",
              contents: [
                { type: "text", text: "สถานที่", size: "sm", color: "#666666", flex: 3 },
                { type: "text", text: safeText(location), size: "sm", wrap: true, flex: 7 },
              ],
            },
            {
              type: "box",
              layout: "baseline",
              spacing: "sm",
              contents: [
                { type: "text", text: "หมายเหตุ", size: "sm", color: "#666666", flex: 3 },
                { type: "text", text: safeText(note, "-"), size: "sm", wrap: true, flex: 7 },
              ],
            },
            {
              type: "box",
              layout: "baseline",
              spacing: "sm",
              contents: [
                { type: "text", text: "สถานะ", size: "sm", color: "#666666", flex: 3 },
                { type: "text", text: safeText(status), size: "sm", wrap: true, flex: 7 },
              ],
            },
          ],
        },
        {
          type: "text",
          text: "หากมีการเปลี่ยนแปลงเวร เจ้าหน้าที่จะอัปเดตในระบบให้อัตโนมัติค่ะ",
          size: "xs",
          color: "#777777",
          wrap: true,
          margin: "md",
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#22C55E",
          action: { type: "uri", label: buttonLabel, uri: buttonUrl || DEFAULT_DOCTOR_PORTAL_URL },
        },
      ],
    },
  };
}

function buildDoctorShiftFlexMessage(bubbleOrCarousel, altText = "แจ้งตารางเวรแพทย์") {
  return { type: "flex", altText, contents: bubbleOrCarousel };
}

// ================= Doctor Tomorrow Summary (CRON helper) =================
async function sendDoctorTomorrowSummary() {
  const bkkNow = getBangkokNow();
  bkkNow.setHours(0, 0, 0, 0);

  const tomorrowStart = new Date(bkkNow);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const dayAfter = new Date(tomorrowStart);
  dayAfter.setDate(dayAfter.getDate() + 1);

  const tsStart = admin.firestore.Timestamp.fromDate(tomorrowStart);
  const tsEnd = admin.firestore.Timestamp.fromDate(dayAfter);

  console.log("[CRON] Summary for date (BKK):", tomorrowStart.toISOString());

  const snap = await db
    .collection("doctor_schedules")
    .where("startAt", ">=", tsStart)
    .where("startAt", "<", tsEnd)
    .where("status", "in", ["confirmed", "pending"])
    .get();

  console.log("[CRON] Raw schedules count =", snap.size);

  if (snap.empty) {
    console.log("[CRON] No schedules for tomorrow");
    return { ok: true, message: "no schedules" };
  }

  const byDoctor = {};
  snap.forEach((doc) => {
    const data = doc.data();
    const doctorUid = data.doctorUid;
    if (!doctorUid) return;

    if (data.summarySent === true) return; // missing = not sent

    if (!byDoctor[doctorUid]) byDoctor[doctorUid] = [];
    byDoctor[doctorUid].push({ id: doc.id, ...data });
  });

  const doctorUids = Object.keys(byDoctor);
  console.log("[CRON] Doctors to notify:", doctorUids);

  const notified = [];
  const batch = db.batch();

  for (const doctorUid of doctorUids) {
    try {
      const doctorRef = db.collection("doctors").doc(doctorUid);
      const doctorSnap = await doctorRef.get();
      if (!doctorSnap.exists) {
        console.warn("[CRON] Doctor not found:", doctorUid);
        continue;
      }

      const doctor = doctorSnap.data();
      const lineUserId = doctor.lineUserId;

      if (!lineUserId || lineUserId === "Uxxxxxxxxxxxx" || lineUserId === "xxxxxxxxxx") {
        console.warn("[CRON] Skip doctor without valid lineUserId:", doctorUid, lineUserId);
        continue;
      }

      const schedules = byDoctor[doctorUid];
      const bubbles = schedules
        .slice()
        .sort((a, b) => (a.startAt?.toMillis?.() || 0) - (b.startAt?.toMillis?.() || 0))
        .map((s) => {
          const start = s.startAt?.toDate?.() || null;
          const dateText = start ? formatDateThaiFromDate(start) : formatThaiDate(tomorrowStart);
          const timeText =
            s.startAt && s.endAt
              ? formatTimeRangeTH(s.startAt, s.endAt)
              : safeText(`${s.startTime || ""}${s.endTime ? `–${s.endTime}` : ""}`, "-");

          return buildDoctorShiftBubble({
            title: "สรุปตารางเวรของคุณสำหรับ “พรุ่งนี้”",
            doctorName: doctor.displayName || doctor.name || "คุณหมอ",
            dateText,
            timeText,
            shiftType: s.shiftType || s.shift || "-",
            location: s.location || "คลินิก",
            note: s.note || "-",
            status: s.status || "-",
            buttonUrl: DEFAULT_DOCTOR_PORTAL_URL,
            buttonLabel: "ดูตารางงานทั้งหมด",
          });
        });

      const contents = bubbles.length <= 1 ? bubbles[0] : { type: "carousel", contents: bubbles };

      await client.pushMessage(
        lineUserId,
        buildDoctorShiftFlexMessage(contents, `สรุปตารางเวรพรุ่งนี้ (${doctor.displayName || "คุณหมอ"})`)
      );

      console.log("[CRON] Sent summary to doctor:", doctorUid, "lineUserId:", lineUserId);

      schedules.forEach((s) => {
        const ref = db.collection("doctor_schedules").doc(s.id);
        batch.update(ref, {
          summarySent: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      notified.push(doctorUid);
    } catch (err) {
      console.error("[CRON] Error sending summary:", doctorUid, err);
      logLineError(err);
    }
  }

  await batch.commit();
  return { ok: true, doctorsNotified: notified };
}

/**
 * แจ้งเตือนเวรที่จะเริ่มในอีก 50–120 นาที (absolute time)
 */
async function sendUpcomingShiftReminders() {
  const now = new Date();
  const windowStart = new Date(now.getTime() + 50 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 120 * 60 * 1000);

  const tsStart = admin.firestore.Timestamp.fromDate(windowStart);
  const tsEnd = admin.firestore.Timestamp.fromDate(windowEnd);

  console.log("[CRON] Reminder window:", windowStart, "->", windowEnd);

  const snap = await db
    .collection("doctor_schedules")
    .where("startAt", ">=", tsStart)
    .where("startAt", "<", tsEnd)
    .where("status", "==", "confirmed")
    .get();

  if (snap.empty) {
    console.log("[CRON] No upcoming shifts");
    return { ok: true, message: "no upcoming shifts" };
  }

  const byDoctor = new Map();
  snap.forEach((doc) => {
    const data = doc.data();
    if (data?.remind1hSent === true) return;

    const doctorUid = data.doctorUid;
    if (!doctorUid) return;

    if (!byDoctor.has(doctorUid)) byDoctor.set(doctorUid, []);
    byDoctor.get(doctorUid).push({ id: doc.id, data, ref: doc.ref });
  });

  if (byDoctor.size === 0) {
    console.log("[CRON] All schedules in window already reminded");
    return { ok: true, message: "already reminded" };
  }

  const notified = [];

  for (const [doctorUid, entries] of byDoctor.entries()) {
    const doctorRef = db.collection("doctors").doc(doctorUid);
    const doctorSnap = await doctorRef.get();
    if (!doctorSnap.exists) {
      console.warn("[CRON] Doctor not found:", doctorUid);
      continue;
    }
    const doctor = doctorSnap.data();
    if (!doctor.lineUserId) {
      console.warn("[CRON] Doctor has no lineUserId:", doctorUid);
      continue;
    }

    const bubbles = entries
      .slice()
      .sort((a, b) => (a.data.startAt?.toMillis?.() || 0) - (b.data.startAt?.toMillis?.() || 0))
      .map((e) => {
        const s = e.data;
        const start = s.startAt?.toDate?.() || null;

        const dateText = start ? formatDateThaiFromDate(start) : safeText(s.date);
        const timeText =
          s.startAt && s.endAt
            ? formatTimeRangeTH(s.startAt, s.endAt)
            : safeText(`${s.startTime || ""}${s.endTime ? `–${s.endTime}` : ""}`, "-");

        return buildDoctorShiftBubble({
          title: "แจ้งเตือนเวรก่อนเริ่ม (ประมาณ 1–2 ชั่วโมง)",
          doctorName: doctor.displayName || doctor.name || "คุณหมอ",
          dateText,
          timeText,
          shiftType: s.shiftType || "-",
          location: s.location || "-",
          note: s.note || "-",
          status: s.status || "-",
          buttonUrl: DEFAULT_DOCTOR_PORTAL_URL,
          buttonLabel: "ดูตารางงานทั้งหมด",
        });
      });

    const contents = bubbles.length <= 1 ? bubbles[0] : { type: "carousel", contents: bubbles };

    try {
      await client.pushMessage(doctor.lineUserId, buildDoctorShiftFlexMessage(contents, "แจ้งเตือนเวรก่อนเริ่ม"));
      console.log("[CRON] Sent reminder to:", doctorUid);

      const batch = db.batch();
      entries.forEach((e) => {
        batch.update(e.ref, {
          remind1hSent: true,
          remind1hSentAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();

      notified.push(doctorUid);
    } catch (err) {
      console.error("[CRON] Error sending reminder:", doctorUid, err);
      logLineError(err);
    }
  }

  return { ok: true, doctorsNotified: notified };
}

// ===== Rate limit /webhook =====
const webhookLimiter = rateLimit({ windowMs: 60_000, max: 90 });

/**
 * /webhook ต้องอยู่ก่อน body parser
 */

const _lineEventSeen = new Map();
function _isDuplicateLineEvent(ev) {
  try {
    const key =
      ev?.webhookEventId ||
      ev?.deliveryContext?.webhookEventId ||
      ev?.message?.id ||
      ev?.replyToken;
    if (!key) return false;

    const now = Date.now();
    const ttl = 2 * 60 * 1000; // 2 นาที
    for (const [k, ts] of _lineEventSeen) {
      if (now - ts > ttl) _lineEventSeen.delete(k);
    }
    if (_lineEventSeen.has(key)) return true;
    _lineEventSeen.set(key, now);
    return false;
  } catch {
    return false;
  }
}

app.post("/webhook", webhookLimiter, middleware(config), async (req, res) => {
  try {
    res.status(200).end();

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const event of events) {
      try {
        if (event?.deliveryContext?.isRedelivery) {
          console.log("[WEBHOOK] skip redelivery:", event.message?.id || event.replyToken);
          continue;
        }
        if (_isDuplicateLineEvent(event)) {
          console.log("[WEBHOOK] skip duplicate event:", event.message?.id || event.replyToken);
          continue;
        }
        await handleEvent(event);
      } catch (err) {
        logLineError(err);
      }
    }
  } catch (err) {
    console.error("[WEBHOOK_ERROR]", err);
  }
});

// ===== JSON body parser (หลัง /webhook) =====
app.use(express.json());

// ==== health check & whoami ====
app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.get("/__whoami", (req, res) => {
  try {
    const appInst = admin.app();
    const options = appInst.options || {};
    const cred = options.credential || {};
    const projectId =
      cred.projectId ||
      cred._projectId ||
      options.projectId ||
      process.env.GCLOUD_PROJECT ||
      "unknown";

    res.json({ ok: true, projectId, from: cred.constructor?.name || "unknown_cred", now: new Date().toISOString() });

    // ========================
    // Public API: Create appointment (from public web / LIFF)
    // - ใช้ Admin SDK เขียน Firestore แทน client เพื่อไม่ต้องเปิด write ใน Firestore Rules
    // - บังคับต้องมี LINE userId (byUser) เพื่อใช้แจ้งเตือนผ่าน LINE ภายหลัง
    // ========================
    const publicAppointmentLimiter = rateLimit({ windowMs: 60_000, max: 12 });

    function _nowBangkokDateKey() {
      // YYYY-MM-DD (Asia/Bangkok)
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      return fmt.format(new Date());
    }

    function _isValidDateKey(s) {
      return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    }

    function _toBangkokMidnightTimestamp(dateKey) {
      // Force Asia/Bangkok midnight (+07:00)
      const d = new Date(`${dateKey}T00:00:00+07:00`);
      if (Number.isNaN(d.getTime())) return null;
      return admin.firestore.Timestamp.fromDate(d);
    }

    function _cleanText(v, { max = 200 } = {}) {
      const s = String(v ?? "").trim();
      if (!s) return "";
      return s.length > max ? s.slice(0, max) : s;
    }

    function _sessionNormalize(v) {
      const s = String(v ?? "").trim().toLowerCase();
      if (s === "morning" || s === "เช้า") return "เช้า";
      if (s === "afternoon" || s === "บ่าย") return "บ่าย";
      return "";
    }

    app.post("/public/appointments", publicAppointmentLimiter, async (req, res) => {
      try {
        const lineUserId = _cleanText(req.body?.lineUserId || req.body?.byUser, { max: 80 });
        const lineDisplayName = _cleanText(req.body?.lineDisplayName, { max: 120 });
        const department = _cleanText(req.body?.department, { max: 120 });
        const dateKey = _cleanText(req.body?.dateKey, { max: 20 });
        const session = _sessionNormalize(req.body?.session);
        const name = _cleanText(req.body?.name, { max: 120 });
        const contact = _cleanText(req.body?.contact, { max: 40 });
        const note = _cleanText(req.body?.note, { max: 800 });

        // บังคับต้องมี LINE userId เพื่อให้ staff/admin ส่งแจ้งเตือนกลับไปหา user ได้
        if (!lineUserId || !lineUserId.startsWith("U")) {
          return res.status(401).json({
            ok: false,
            error: "กรุณาเปิดหน้านี้ผ่าน LINE (LIFF) และล็อกอินก่อน เพื่อรับแจ้งเตือนนัดหมายค่ะ",
          });
        }

        if (!department) return res.status(400).json({ ok: false, error: "กรุณาเลือก/กรอกแผนก" });
        if (!_isValidDateKey(dateKey)) return res.status(400).json({ ok: false, error: "กรุณาเลือกวันที่ให้ถูกต้อง" });
        if (!session) return res.status(400).json({ ok: false, error: "กรุณาเลือกช่วงเวลา (เช้า/บ่าย)" });
        if (!name) return res.status(400).json({ ok: false, error: "กรุณากรอกชื่อผู้รับบริการ" });
        if (!contact) return res.status(400).json({ ok: false, error: "กรุณากรอกเบอร์ติดต่อ" });

        // กันวันที่ย้อนหลัง (อ้างอิง Asia/Bangkok)
        const todayKey = _nowBangkokDateKey();
        if (dateKey < todayKey) {
          return res.status(400).json({ ok: false, error: "ไม่สามารถเลือกวันที่ย้อนหลังได้" });
        }

        const dateAt = _toBangkokMidnightTimestamp(dateKey);
        if (!dateAt) return res.status(400).json({ ok: false, error: "วันที่ไม่ถูกต้อง" });

        // กันสมัครซ้ำ: byUser(lineUserId) + dateKey + session + department (ที่ยัง active)
        const dupSnap = await db
          .collection("appointments")
          .where("byUser", "==", lineUserId)
          .where("dateKey", "==", dateKey)
          .where("session", "==", session)
          .where("department", "==", department)
          .limit(3)
          .get();

        if (!dupSnap.empty) {
          const active = dupSnap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .find((r) => String(r.status || "pending") !== "cancelled");

          if (active) {
            return res.status(409).json({
              ok: false,
              error: "คุณมีคำขอนัดหมายช่วงนี้อยู่แล้ว",
              duplicate: { id: active.id, status: active.status || "pending" },
            });
          }
        }

        const payload = {
          byUser: lineUserId,
          lineUserId,
          lineDisplayName: lineDisplayName || null,
          department,
          dateKey,
          dateAt,
          session,
          name,
          contact,
          note,
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          source: "liff",
        };

        const ref = await db.collection("appointments").add(payload);
        return res.json({ ok: true, id: ref.id });
      } catch (e) {
        console.error("[PUBLIC_APPOINTMENT_CREATE]", e);
        return res.status(500).json({ ok: false, error: "server error" });
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ========================
// DEBUG: Ollama endpoint
// ========================
// ใช้ทดสอบง่าย ๆ: POST http://localhost:3000/debug/ollama  { "text": "..." }
// Guard: อนุญาตเฉพาะ localhost/127.0.0.1 หรือส่ง X-Debug-Key ให้ตรงกับ DEBUG_SECRET
function _isLocalRequest(req) {
  const ip = (req.ip || "").toString();
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("::ffff:127.0.0.1")) return true;
  const host = (req.headers.host || "").toString();
  if (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) return true;
  return false;
}

app.post("/debug/ollama", async (req, res) => {
  try {
    const debugKey = req.headers["x-debug-key"] || req.query.key;
    const expected = process.env.DEBUG_SECRET || "";

    if (!_isLocalRequest(req) && (!expected || debugKey !== expected)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.status(400).json({ ok: false, error: "missing text" });

    const userId = (req.body?.userId || "debug_user").toString();
    const conversationId = (req.body?.conversationId || "debug_conv").toString();

    const out = await arisaLLMReply({ userText: text, conversationId, userId });
    return res.json({ ok: true, out });
  } catch (e) {
    console.error("[DEBUG_OLLAMA_ERROR]", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "internal error" });
  }
});

// ===== Static & Home =====
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- ตรวจแอดมิน (Bearer ID Token + custom claim) ----
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/i);
    if (!m) {
      console.error("[AUTH] missing bearer header | origin:", req.headers.origin);
      return res.status(401).json({ error: "missing token" });
    }

    const decoded = await admin.auth().verifyIdToken(m[1]);
    if (decoded.admin === true) {
      req.user = decoded;
      return next();
    }
    console.error("[AUTH] no admin claim:", decoded.uid, decoded.email);
    return res.status(403).json({ error: "forbidden" });
  } catch (err) {
    console.error("[AUTH] verifyIdToken error:", err?.code, err?.message);
    return res.status(401).json({ error: "invalid token" });
  }
}

// ✅ Staff หรือ Admin (เฉพาะ endpoint ที่ต้องการ)
async function requireStaffOrAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/i);
    if (!m) return res.status(401).json({ error: "missing token" });

    const decoded = await admin.auth().verifyIdToken(m[1]);

    const ok = decoded.admin === true || decoded.role === "admin" || decoded.staff === true || decoded.role === "staff";
    if (!ok) return res.status(403).json({ error: "forbidden" });

    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "invalid token" });
  }
}

// ===== Cron auth helper (PATCH: disable if CRON_SECRET missing) =====
function verifyCronKey(req) {
  const key = req.query.key || req.headers["x-cron-key"];
  const expectedKey = process.env.CRON_SECRET || CRON_SECRET;

  if (!expectedKey) return { ok: false, status: 503, error: "cron disabled (missing CRON_SECRET)" };
  if (!key || key !== expectedKey) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true };
}

// ===== Notify-now helpers =====
function toDateMaybe(v) {
  if (!v) return null;
  if (typeof v?.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// PATCH: normalize time text for notify-now safely (Date-based)
function formatTimeRangeFromDatesBkk(startDate, endDate) {
  if (!startDate) return "-";
  const fmt = (d) =>
    new Intl.DateTimeFormat("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Bangkok",
    }).format(d);

  const s = fmt(startDate);
  const e = endDate ? fmt(endDate) : null;
  return e ? `${s}–${e} น.` : `${s} น.`;
}

async function findDoctorLineUserId(doctorUid) {
  if (!doctorUid) return null;

  const candidates = [
    { col: "doctors", fields: ["lineUserId", "line_user_id", "lineUid"] },
    { col: "users", fields: ["lineUserId", "line_user_id", "lineUid"] },
    { col: "doctor_profiles", fields: ["lineUserId", "line_user_id", "lineUid"] },
  ];

  for (const c of candidates) {
    const snap = await db.collection(c.col).doc(doctorUid).get();
    if (!snap.exists) continue;
    const data = snap.data() || {};
    for (const f of c.fields) {
      if (data[f]) return data[f];
    }
  }
  return null;
}

// ===== Admin API: ส่งแจ้งเตือนเวร "ทันที" =====
app.post("/admin/doctor-schedules/notify-now", requireStaffOrAdmin, async (req, res) => {
  try {
    const { scheduleId } = req.body || {};
    if (!scheduleId) return res.status(400).json({ ok: false, error: "missing scheduleId" });

    const ref = db.collection("doctor_schedules").doc(scheduleId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "schedule not found" });

    const s = snap.data() || {};
    const doctorUid = s.doctorUid || s.doctorId || s.ownerUid || null;

    const doctorName = s.doctorName || s.doctorDisplayName || s.doctor || "คุณหมอ";
    const startAtDate = toDateMaybe(s.startAt);
    const endAtDate = toDateMaybe(s.endAt);

    const shift = s.shift || s.shiftType || s.type || "-";
    const location = s.location || s.place || "-";
    const note = s.note || s.remark || "";
    const status = s.status || "active";

    const lineUserId = await findDoctorLineUserId(doctorUid);
    if (!lineUserId) {
      return res.status(400).json({
        ok: false,
        error: "doctor has no lineUserId (set it in doctors/{doctorUid} or users/{doctorUid} or doctor_profiles/{doctorUid})",
      });
    }

    const dateText = startAtDate ? formatDateThaiFromDate(new Date(startAtDate)) : safeText(s.date);
    const timeText = startAtDate
      ? formatTimeRangeFromDatesBkk(startAtDate, endAtDate)
      : safeText(`${s.startTime || ""}${s.endTime ? `–${s.endTime}` : ""}`, "-");

    const bubble = buildDoctorShiftBubble({
      title: "แจ้งตารางเวรแพทย์ (ส่งทันที)",
      doctorName,
      dateText,
      timeText,
      shiftType: shift,
      location,
      note,
      status,
      buttonUrl: DEFAULT_DOCTOR_PORTAL_URL,
      buttonLabel: "ดูตารางงานทั้งหมด",
    });

    await client.pushMessage(lineUserId, buildDoctorShiftFlexMessage(bubble, "แจ้งตารางเวรแพทย์ (ส่งทันที)"));

    await ref.set(
      {
        manualNotifyAt: admin.firestore.FieldValue.serverTimestamp(),
        manualNotifyBy: req.user?.email || req.user?.uid || "admin",
      },
      { merge: true }
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("[NOTIFY_NOW_ERROR]", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ===== Helper: แจ้งเตือนผู้ใช้ผ่าน LINE Push =====
export async function pushApptUpdate(userId, { status, department, dateStr, session }) {
  const flex = buildApptStatusFlex({ status, department, dateStr, session });
  await lineClient.pushMessage(userId, flex);
}

// ===== Flex Message helpers =====
function buildInfoRow(label, value) {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: label, color: "#888888", size: "xs", flex: 3 },
      { type: "text", text: value, color: "#333333", size: "xs", wrap: true, flex: 8 },
    ],
  };
}

// ===== Appointment Flex =====
function buildApptConfirmFlex(session) {
  return {
    type: "flex",
    altText: "โปรดยืนยันนัดหมายค่ะ",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "โปรดยืนยันนัดหมายนี้นะคะ 💕", weight: "bold", size: "md", wrap: true },
          {
            type: "box",
            layout: "vertical",
            margin: "md",
            spacing: "xs",
            contents: [
              buildInfoRow("แผนก", session.department),
              buildInfoRow("วันที่", `${formatDateTH(session.dateKey)} (${session.dateKey})`),
              buildInfoRow("ช่วงเวลา", session.time),
              buildInfoRow("ติดต่อ", `${session.name} / ${session.phone}`),
            ],
          },
          {
            type: "text",
            text: 'ถ้าต้องการเปลี่ยนรายละเอียดบางส่วน สามารถพิมพ์ "เปลี่ยนวันที่" หรือ "เปลี่ยนช่วงเวลา" ได้เลยนะคะ',
            size: "xs",
            color: "#888888",
            wrap: true,
            margin: "md",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          { type: "button", style: "secondary", color: "#FFCDD2", action: { type: "message", label: "ยกเลิก", text: "ยกเลิก" } },
          { type: "button", style: "primary", color: "#4CAF50", action: { type: "message", label: "ยืนยัน", text: "ยืนยัน" } },
        ],
        flex: 0,
      },
    },
  };
}

function buildApptSuccessFlex(payload) {
  return {
    type: "flex",
    altText: "นัดหมายสำเร็จแล้วค่ะ",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "box", layout: "baseline", spacing: "sm", contents: [{ type: "text", text: "✅ นัดหมายสำเร็จแล้วค่ะ", weight: "bold", size: "md", wrap: true }] },
          {
            type: "box",
            layout: "vertical",
            margin: "md",
            spacing: "xs",
            contents: [
              buildInfoRow("แผนก", payload.department),
              buildInfoRow("วันที่", `${formatDateTH(payload.dateKey)} (${payload.dateKey})`),
              buildInfoRow("ช่วงเวลา", payload.session),
              buildInfoRow("ติดต่อ", `${payload.name} / ${payload.contact}`),
            ],
          },
          { type: "text", text: "(สถานะ: รอการยืนยันนัดจากเจ้าหน้าที่ค่ะ)", size: "xs", color: "#888888", wrap: true, margin: "md" },
        ],
      },
    },
  };
}

function buildApptStatusFlex({ status, department, dateStr, session }) {
  let statusText = "";
  let statusColor = "#333333";
  if (status === "confirmed") {
    statusText = "✅ ได้รับการยืนยันแล้ว";
    statusColor = "#2E7D32";
  } else if (status === "cancelled") {
    statusText = "❌ ถูกยกเลิก";
    statusColor = "#C62828";
  } else if (status === "rescheduled") {
    statusText = "🔁 มีการเลื่อนนัด";
    statusColor = "#EF6C00";
  } else {
    statusText = `อัปเดตสถานะ: ${status}`;
  }

  return {
    type: "flex",
    altText: "อัปเดตสถานะนัดหมายค่ะ",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "อัปเดตสถานะนัดหมายค่ะ", weight: "bold", size: "md", wrap: true },
          { type: "box", layout: "vertical", margin: "md", spacing: "xs", contents: [buildInfoRow("แผนก", department), buildInfoRow("วันที่", dateStr), buildInfoRow("ช่วงเวลา", session)] },
          { type: "text", text: statusText, size: "sm", color: statusColor, weight: "bold", wrap: true, margin: "md" },
        ],
      },
    },
  };
}

// ===== Helpers: Medical Certificate PDF =====
// file: index.js
// === REPLACE ทั้งฟังก์ชันนี้: buildCertificatePdfBytes(data) ===
// PATCH(2026-01-15): PDF layout ใบรับรองแพทย์ให้ใกล้เคียงแบบฟอร์ม (A4 + ช่อง/เส้น/checkbox)

// file: index.js
// ✅ Replace your existing buildCertificatePdfBytes(data) with this improved version
// ===== Helpers: Medical Certificate PDF =====
// ===== PATCH: buildCertificatePdfBytes (replace whole function) =====
async function buildCertificatePdfBytes(data) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const page = pdf.addPage([595, 842]); // A4 (pt)
  const { width, height } = page.getSize();

  const fontBytes = fs.readFileSync(path.join(__dirname, "fonts", "THSarabunNew.ttf"));
  const thaiFont = await pdf.embedFont(fontBytes, { subset: true });

  const BLACK = rgb(0, 0, 0);

  // ---- normalize input fields (รองรับชื่อฟิลด์หลายแบบ) ----
  const fullName = data.fullName ?? data.fullname ?? data.full_name ?? data.name ?? "";
  const idcard = String(data.idcard ?? data.idCard ?? data.nationalId ?? data.national_id ?? "")
    .replace(/\D/g, "")
    .slice(0, 13);

  const address = data.address ?? data.addr ?? "";
  const doctorName = data.doctorName ?? data.doctor ?? "";
  const diagnosis = data.diagnosis ?? "";
  const daysOff = data.daysOff ?? data.dayOff ?? data.days_off ?? null;

  // วันที่ออกเอกสาร: ถ้ามี approvedAt ใช้อันนั้น, ไม่งั้นใช้วันนี้
  const approvedAt = data.approvedAt?.toDate ? data.approvedAt.toDate() : null;
  const issuedDateObj = approvedAt || new Date();
  const issuedDate = issuedDateObj.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // ---------- helpers ----------
  const yFromTop = (t) => height - t;

  const drawText = (text, x, y, size = 14) => {
    page.drawText(String(text ?? ""), { x, y, size, font: thaiFont, color: BLACK });
  };

  const drawCenter = (text, top, size = 26) => {
    const t = String(text ?? "");
    const w = thaiFont.widthOfTextAtSize(t, size);
    drawText(t, (width - w) / 2, yFromTop(top), size);
  };

  const drawLine = (x1, y1, x2, y2, thickness = 1) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: BLACK });
  };

  const dottedLine = (x1, y, x2, dash = 2.5, gap = 2, thickness = 1) => {
    let x = x1;
    while (x < x2) {
      drawLine(x, y, Math.min(x + dash, x2), y, thickness);
      x += dash + gap;
    }
  };

  const box = (x, y, w, h, thickness = 1) => {
    page.drawRectangle({ x, y, width: w, height: h, borderColor: BLACK, borderWidth: thickness });
  };

  const checkbox = (x, y, size = 10) => box(x, y, size, size, 1);

  // wrap ตาม "ความกว้างจริง" (รองรับภาษาไทยที่ไม่มีช่องว่าง)
  const wrapByWidth = (text, maxWidth, size = 14) => {
    const s = String(text ?? "");
    if (!s) return [""];
    const lines = [];
    let line = "";
    for (const ch of s) {
      const next = line + ch;
      const w = thaiFont.widthOfTextAtSize(next, size);
      if (w > maxWidth && line.length > 0) {
        lines.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  // วาด label + เส้นประใต้ (เส้นอยู่ใต้ข้อความ ป้องกันเส้นทับตัวอักษร)
  const drawLabelWithLine = (label, x, top, lineX1, lineX2, size = 14, lineOffset = 14) => {
    drawText(label, x, yFromTop(top), size);
    dottedLine(lineX1, yFromTop(top + lineOffset), lineX2, 2.5, 2, 1);
  };

  // ---------- layout constants ----------
  const marginL = 46;
  const marginR = 46;
  const contentW = width - marginL - marginR;

  // ---------- header ----------
  drawCenter("ใบรับรองแพทย์", 56, 26);

  // เล่มที่ / เลขที่
  drawText("เล่มที่", marginL, yFromTop(82), 14);
  dottedLine(marginL + 40, yFromTop(82 + 12), marginL + 150, 2.5, 2, 1);

  drawText("เลขที่", width - marginR - 160, yFromTop(82), 14);
  dottedLine(width - marginR - 115, yFromTop(82 + 12), width - marginR, 2.5, 2, 1);

  // ---------- section 1 ----------
  const sec1Top = 106;
  const sec1H = 250;

  box(marginL, yFromTop(sec1Top + sec1H), contentW, sec1H, 1);
  drawText("ส่วนที่ 1  ของผู้ขอรับใบรับรองสุขภาพ", marginL + 14, yFromTop(sec1Top + 22), 14);

  // ชื่อ
  let top = sec1Top + 48;
  drawLabelWithLine("ข้าพเจ้า  นาย/นาง/นางสาว", marginL + 14, top, marginL + 170, marginL + contentW - 14, 14, 14);
  if (fullName) drawText(fullName, marginL + 175, yFromTop(top), 14);

  // ที่อยู่
  top += 24;
  drawLabelWithLine("สถานที่อยู่ (ที่สามารถติดต่อได้)", marginL + 14, top, marginL + 215, marginL + contentW - 14, 14, 14);
  if (address) {
    const maxW = (marginL + contentW - 14) - (marginL + 220);
    const addrLines = wrapByWidth(address, maxW, 14).slice(0, 2);
    drawText(addrLines[0], marginL + 220, yFromTop(top), 14);
    if (addrLines[1]) drawText(addrLines[1], marginL + 220, yFromTop(top + 18), 14);
  }

  // เลขบัตรประชาชน (13 ช่อง)
  top += 28;
  drawText("หมายเลขบัตรประจำตัวประชาชน", marginL + 14, yFromTop(top), 14);
  const idStartX = marginL + 250;
  const idBox = 14;
  const idGap = 3;
  const idY = yFromTop(top) - 12;
  for (let i = 0; i < 13; i++) {
    const x = idStartX + i * (idBox + idGap);
    box(x, idY, idBox, idBox, 1);
    if (idcard[i]) drawText(idcard[i], x + 4, idY + 2, 12);
  }

  // ประวัติสุขภาพ 1-4
  top += 30;
  drawText("ข้าพเจ้าขอใบรับรองสุขภาพโดยมีประวัติสุขภาพดังนี้", marginL + 14, yFromTop(top), 14);

  const items = [
    "1. โรคประจำตัว",
    "2. อุบัติเหตุ และ ผ่าตัด",
    "3. เคยเข้ารับการรักษาในโรงพยาบาล",
    "4. ประวัติอื่นที่สำคัญ",
  ];

  let rowTop = top + 20;
  const rowStep = 20;
  for (let i = 0; i < items.length; i++) {
    drawText(items[i], marginL + 28, yFromTop(rowTop), 14);

    const cx = marginL + 270;
    const yText = yFromTop(rowTop);
    const cbY = yText - 8;
    checkbox(cx, cbY, 10);
    drawText("ไม่มี", cx + 16, yText, 14);

    checkbox(cx + 60, cbY, 10);
    drawText("มี(ระบุ)", cx + 76, yText, 14);

    dottedLine(marginL + 380, yFromTop(rowTop + 12), marginL + contentW - 14, 2.5, 2, 1);
    rowTop += rowStep;
  }

  // ลายเซ็น + วันที่
  const signTop = sec1Top + sec1H - 18;
  drawText("ลงชื่อ", marginL + 250, yFromTop(signTop), 14);
  dottedLine(marginL + 288, yFromTop(signTop + 12), marginL + 420, 2.5, 2, 1);

  drawText("วันที่", marginL + 430, yFromTop(signTop), 14);
  dottedLine(marginL + 460, yFromTop(signTop + 12), marginL + contentW - 14, 2.5, 2, 1);

  // ---------- section 2 ----------
  const sec2Top = sec1Top + sec1H + 22;
  const sec2H = 390;

  box(marginL, yFromTop(sec2Top + sec2H), contentW, sec2H, 1);
  drawText("ส่วนที่ 2  ของแพทย์", marginL + 14, yFromTop(sec2Top + 22), 14);

  let yTop = sec2Top + 50;
  drawLabelWithLine("สถานที่ตรวจ", marginL + 14, yTop, marginL + 90, marginL + 320, 14, 14);
  drawLabelWithLine("วันที่", marginL + 330, yTop, marginL + 360, marginL + contentW - 14, 14, 14);

  yTop += 24;
  drawLabelWithLine("ข้าพเจ้า  นายแพทย์/แพทย์หญิง", marginL + 14, yTop, marginL + 210, marginL + contentW - 14, 14, 14);
  if (doctorName) drawText(doctorName, marginL + 215, yFromTop(yTop), 14);

  yTop += 24;
  drawLabelWithLine("ใบอนุญาตประกอบวิชาชีพเวชกรรมเลขที่", marginL + 14, yTop, marginL + 270, marginL + contentW - 14, 14, 14);

  yTop += 24;
  drawLabelWithLine("สถานที่ประกอบวิชาชีพเวชกรรม", marginL + 14, yTop, marginL + 200, marginL + contentW - 14, 14, 14);

  yTop += 24;
  drawLabelWithLine("ได้ตรวจร่างกาย", marginL + 14, yTop, marginL + 105, marginL + 260, 14, 14);
  drawLabelWithLine("นาย/นาง/นางสาว", marginL + 270, yTop, marginL + 390, marginL + contentW - 14, 14, 14);
  if (fullName) drawText(fullName, marginL + 395, yFromTop(yTop), 14);

  yTop += 28;
  drawLabelWithLine("แล้วเมื่อวันที่", marginL + 14, yTop, marginL + 95, marginL + 260, 14, 14);
  drawLabelWithLine("เดือน", marginL + 270, yTop, marginL + 310, marginL + 400, 14, 14);
  drawLabelWithLine("พ.ศ.", marginL + 410, yTop, marginL + 445, marginL + 520, 14, 14);

  drawText("มีรายละเอียดดังนี้", marginL + 14, yFromTop(yTop + 22), 14);

  // ช่องรายละเอียด
  yTop += 50;
  drawText("น้ำหนักตัว", marginL + 14, yFromTop(yTop), 14);
  dottedLine(marginL + 80, yFromTop(yTop + 12), marginL + 145, 2.5, 2, 1);
  drawText("กก.", marginL + 150, yFromTop(yTop), 14);

  drawText("ความสูง", marginL + 185, yFromTop(yTop), 14);
  dottedLine(marginL + 240, yFromTop(yTop + 12), marginL + 320, 2.5, 2, 1);
  drawText("เซนติเมตร", marginL + 325, yFromTop(yTop), 14);

  drawText("ความดันโลหิต", marginL + 400, yFromTop(yTop), 14);
  dottedLine(marginL + 490, yFromTop(yTop + 12), marginL + contentW - 14, 2.5, 2, 1);

  yTop += 22;
  drawText("มม.ปรอท", marginL + 14, yFromTop(yTop), 14);
  drawText("ชีพจร", marginL + 90, yFromTop(yTop), 14);
  dottedLine(marginL + 130, yFromTop(yTop + 12), marginL + 195, 2.5, 2, 1);
  drawText("ครั้ง/นาที", marginL + 200, yFromTop(yTop), 14);

  // สรุปความเห็น/ข้อแนะนำ
  yTop += 26;
  drawText("สรุปความเห็นและข้อแนะนำของแพทย์", marginL + 14, yFromTop(yTop), 14);

  yTop += 18;
  for (let i = 0; i < 3; i++) {
    dottedLine(marginL + 14, yFromTop(yTop + 10), marginL + contentW - 14, 2.5, 2, 1);
    yTop += 18;
  }

  // ใส่ diagnosis (1-2 บรรทัด)
  if (diagnosis) {
    const dLines = wrapByWidth(diagnosis, contentW - 28, 14).slice(0, 2);
    drawText(dLines[0], marginL + 18, yFromTop(yTop - 54), 14);
    if (dLines[1]) drawText(dLines[1], marginL + 18, yFromTop(yTop - 36), 14);
  }

  // ลายเซ็นแพทย์ (ขยับให้ไม่ชนขอบขวา)
  const bottomTop = sec2Top + sec2H - 46;
  drawText("ลงชื่อ", marginL + 250, yFromTop(bottomTop), 14);
  dottedLine(marginL + 292, yFromTop(bottomTop + 12), marginL + 430, 2.5, 2, 1);
  drawText("แพทย์ผู้ตรวจร่างกาย", marginL + 435, yFromTop(bottomTop), 14);

  // วันที่ออกเอกสาร
  drawText(`วันที่ออกเอกสาร: ${issuedDate}`, marginL + 14, yFromTop(sec2Top + sec2H - 22), 11);

  // วันหยุดพักรักษา
  if (daysOff !== "" && daysOff !== null && daysOff !== undefined) {
    drawText(`พัก ${String(daysOff)} วัน`, marginL + 14, yFromTop(sec2Top + sec2H - 38), 11);
  }

  return await pdf.save();
}

// ===== LINE error logger =====
function logLineError(err) {
  const detail = err?.originalError?.response?.data || err?.response?.data || null;
  if (detail) {
    console.error("[LINE_ERROR]", JSON.stringify(detail, null, 2));
    return;
  }
  console.error("[LINE_ERROR]", err?.message || err);
}


// ===== Study helper: "อาหารและยา" (อ่านสอบ) =====
function isFoodDrugStudyQuestion(text) {
  const t = String(text || "").toLowerCase();
  const hasExam = /สอบ|อ่านสอบ|สรุป|ติว|เนื้อหา/.test(t);
  const hasFoodDrug = /อาหาร/.test(t) && /ยา/.test(t);
  return hasExam && hasFoodDrug;
}

function buildFoodDrugStudySummary() {
  const lines = [];
  lines.push("สรุปอ่านสอบ: “อาหาร & ยา” (แบบปลอดภัย) 📚");
  lines.push("");
  lines.push("1) หลักการพื้นฐาน");
  lines.push("• อ่านฉลาก/วิธีใช้ยา และทำตามคำแนะนำของแพทย์/เภสัชกร");
  lines.push("• ยาบางชนิดต้องกิน “ก่อนอาหาร/พร้อมอาหาร/หลังอาหาร” เพราะมีผลต่อการดูดซึมและการระคายเคืองกระเพาะ");
  lines.push("• หลีกเลี่ยงการกินยาหลายชนิดพร้อมกันโดยไม่รู้ว่าซ้ำตัวยาหรือไม่");
  lines.push("");
  lines.push("2) ตัวอย่างปฏิกิริยาที่พบบ่อย (แนวคิด ไม่ลงขนาดยา)");
  lines.push("• คาเฟอีน (กาแฟ/ชา/ชูกำลัง) + ยาบางชนิด → ใจสั่น นอนไม่หลับ กระสับกระส่ายได้");
  lines.push("• แอลกอฮอล์ + ยาที่ทำให้ง่วง/เวียนหัว หรือยาบางชนิด → เสี่ยงง่วงมาก อุบัติเหตุ หรืออันตรายต่อตับ");
  lines.push("• นม/แคลเซียมสูง (นม/โยเกิร์ต/อาหารเสริมแคลเซียม) อาจลดการดูดซึมของยาบางกลุ่ม (บางชนิดต้องเว้นช่วง)");
  lines.push("• เกรปฟรุต/น้ำเกรปฟรุต อาจมีผลกับยาบางชนิด (ควรหลีกเลี่ยงถ้าไม่แน่ใจ)");
  lines.push("");
  lines.push("3) เทคนิคจำง่ายเพื่อทำข้อสอบ");
  lines.push("• ถ้ากินยาแล้ว “ระคายท้อง” มักแก้ด้วยการกินพร้อมอาหาร (ยกเว้นยาที่ระบุให้กินก่อนอาหาร)");
  lines.push("• ถ้าเป็นยาที่ต้อง “เว้นช่วง” ให้จำหลักการว่า เว้นช่วงอย่างน้อย ~2 ชม. แล้วดูฉลากเป็นหลัก");
  lines.push("• ยาที่ทำให้ง่วง: หลีกเลี่ยงแอลกอฮอล์/ขับรถ และระวังการใช้ร่วมกับยานอนหลับ");
  lines.push("");
  lines.push("4) เช็กลิสต์ก่อนตอบ/ก่อนใช้ยา");
  lines.push("• ยานี้กินก่อนหรือหลังอาหาร?");
  lines.push("• ห้ามร่วมกับแอลกอฮอล์/คาเฟอีน/นม/เกรปฟรุตหรือไม่?");
  lines.push("• มีโรคประจำตัว/แพ้ยา/ตั้งครรภ์/ให้นมบุตรไหม?");
  lines.push("");
  lines.push("⚠️ หมายเหตุ: เป็นความรู้เบื้องต้นเพื่อการเรียน ไม่แทนคำแนะนำแพทย์/เภสัชกรนะคะ");
  lines.push("ถ้าอยากให้สรุปแบบแนวข้อสอบเพิ่ม บอกได้เลยว่าอยากเน้นหัวข้อไหน (เช่น ยากับนม / ยากับแอลกอฮอล์ / ยากับกาแฟ) 😊");
  return lines.join("\n");
}

// ===== Small talk & Flow helpers =====
const smallTalkMap = new Map([
  [["อาริศาอายุเท่าไหร่", "อาริศาอายุกี่ปี", "อายุเท่าไหร่"], "อาริศา 22 ปีค่ะ แต่ใจยังเด็กอยู่เลย 💕"],
  [["อาริศาทำอะไรได้บ้าง", "ทำอะไรได้บ้าง"], "อาริศาช่วยนัดหมอ เช็กอาการ แล้วก็คุยเล่นกับคุณได้ค่ะ 😄"],
  [["คุยกับอาริศา"], "ตอนนี้โหมดคุยกับอาริศากำลังพัฒนาอยู่ค่ะ 🛠️ dev กำลังปั่นงานจนแทบไม่ได้นอนเลย 😅 อดใจรออีกนิดนะคะ 💖"],
  [["อาริศาชอบทำอะไร", "ชอบทำอะไร"], "อาริศาชอบช่วยคนค่ะ แล้วก็ชอบคุยกับคุณที่สุดเลย 💖"],
  [["หวัดดี", "ดีค่ะ", "Hello", "Hi", "สวัสดี", "สวัสดีค่ะ"], "สวัสดีค่ะ~ ☀️ Arisa ยินดีที่ได้รู้จักนะคะ 💖 วันนี้รู้สึกยังไงบ้างคะ? 😊"],
  [["ใครเป็นคนสร้าง Arisa?", "ใครเป็นคนสร้างอริศา"], "👩‍⚕️ อาริศา: Arisa ถูกสร้างโดยทีม MedEase แสนใจดีค่ะ 🛠️💙 ไว้ช่วยดูแลสุขภาพคุณ 🩺✨"],
  [["รู้จักอภิวัฒน์ไหม"], "👩‍⚕️ อาริศา: รู้จักสิคะ! คุณอภิวัฒน์คือ dev คนเก่งที่สร้าง MedEase กับ Arisa เลยค่ะ 🛠️💖"],
  [["คุณชื่ออะไร"], "สวัสดีค่ะ~ 💖 หนูชื่อ Arisa ผู้ช่วยด้านสุขภาพจาก MedEase ค่ะ 👩‍⚕️✨ ฝากตัวด้วยนะคะ 🌷"],
]);

function getSmallTalkResponse(inputText) {
  for (const [k, r] of smallTalkMap.entries()) {
    if (k.some((s) => inputText.includes(s))) return r;
  }
  return null;
}

// ===== Joke helper (Small talk) =====
// ป้องกันอาการตอบซ้ำเทมเพลตเวลา user ขอ "เรื่องตลก" โดยให้สุ่มมุกสั้น ๆ (ปลอดภัย ไม่เสียดสี) แทน
const ARISA_JOKES = [
  "ทำไมคอมพ์ถึงหนาว? เพราะเปิด Windows ไว้ค่ะ 😄",
  "ทำไมกาแฟถึงชอบตื่นเช้า? เพราะมันกลัวถูกเรียกว่ากาแฟ ‘ง่วง’ ค่ะ ☕😆",
  "ทำไมสายชาร์จถึงเศร้า? เพราะโดนดึงไป-ดึงมาบ่อยค่ะ 🔌🥺",
  "ทำไมหนังสือถึงชอบเงียบ? เพราะมันมีแต่ ‘ตัวอักษร’ ไม่ใช่ ‘ตัวเสียง’ ค่ะ 🤭",
  "ทำไมช้อนถึงไม่เถียง? เพราะมันเป็นคน ‘ตัก’ แต่ไม่ ‘ตัดสิน’ ค่ะ 🥄😄",
  "ทำไมแมวชอบนอน? เพราะมันอยากเป็น ‘แมวพักผ่อน’ ค่ะ 🐱💤",
];

function isJokeRequest(inputText) {
  const t = String(inputText || "").toLowerCase();
  return /(เรื่องตลก|มุก|เล่า.*ตลก|ตลก.*หน่อย|เล่น.*ให้ดู|ขำๆ)/.test(t);
}

function pickRandomJoke() {
  return ARISA_JOKES[Math.floor(Math.random() * ARISA_JOKES.length)];
}


// ===== Quick Reply sets for symptom follow-up =====
const QR_FEVER = [
  { label: "ยังไม่ได้วัด", text: "ยังไม่ได้วัด" },
  { label: "< 38°C", text: "ไข้ต่ำกว่า 38" },
  { label: "38–39°C", text: "ไข้ 38-39" },
  { label: "> 39°C", text: "ไข้มากกว่า 39" },
];

const QR_COMORBID = [
  { label: "มีไอ", text: "มีไอ" },
  { label: "มีน้ำมูก", text: "มีน้ำมูก" },
  { label: "ปวดเมื่อย", text: "ปวดเมื่อย" },
  { label: "ไม่มีอาการร่วม", text: "ไม่มีอาการร่วม" },
];

const QR_DANGER = [
  { label: "หายใจลำบาก", text: "หายใจลำบาก" },
  { label: "กลืนลำบากมาก", text: "กลืนลำบากมาก" },
  { label: "ซึม/อ่อนแรงมาก", text: "ซึม/อ่อนแรงมาก" },
  { label: "ไม่มีสัญญาณอันตราย", text: "ไม่มีสัญญาณอันตราย" },
];

const SYMPTOM_HINT_REGEX =
  /(เจ็บ|ปวด|ท้อง|ท้องเสีย|อาเจียน|คลื่นไส้|เวียนหัว|ไอ|น้ำมูก|ไข้|ปวดหัว|แน่นหน้าอก|หายใจลำบาก)/i;

let userSessions = {};

// ===== Helper: หา/สร้างห้องสนทนา =====
async function getOrCreateConversation({ lineUserId, ownerUid = null }) {
  const snap = await db
    .collection("conversations")
    .where("userId", "==", lineUserId)
    .where("status", "==", "open")
    .limit(1)
    .get();

  if (!snap.empty) {
    const doc = snap.docs[0];
    return { id: doc.id, data: doc.data(), isNew: false };
  }

  const convRef = db.collection("conversations").doc();
  const now = admin.firestore.FieldValue.serverTimestamp();

  const convData = {
    userId: lineUserId,
    ownerUid: ownerUid || null,
    status: "open",
    createdAt: now,
    lastMessageAt: now,
    lastMessageText: "",
    createdBy: "user",
    doctorId: null,
  };

  await convRef.set(convData);
  return { id: convRef.id, data: convData, isNew: true };
}

// ===== Handle LINE events =====
async function handleEvent(event) {
  if (event.type === "postback") {
    return reply(event.replyToken, "ได้รับคำสั่งแล้วค่ะ");
  }

  if (event.type !== "message") return;

  const userId = event.source?.userId;
  if (!userId) return;

  const rawType = event.message?.type || "unknown";
  const text = rawType === "text" ? String(event.message?.text || "").trim() : "";

  const logText = text; // ✅ กัน ReferenceError: logText is not defined
  const locationMeta =
    rawType === "location"
      ? {
          title: String(event?.message?.title || ""),
          address: String(event?.message?.address || ""),
          latitude: event?.message?.latitude,
          longitude: event?.message?.longitude,
        }
      : null;

  // ===== Conversation logging =====
  let conversationId = null;
  try {
    const { id } = await getOrCreateConversation({ lineUserId: userId, ownerUid: null });
    conversationId = id;

    // PATCH(Profile Memory): extract & store simple facts from user text
    const profileKey = getArisaProfileKey({ userId, conversationId });
    let facts = {};
    if (typeof extractProfileFacts === "function") {
      try {
        facts = extractProfileFacts(logText);
      } catch {}
    }
    if (facts && Object.keys(facts).length) {
      await upsertArisaProfile(profileKey, facts);
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    await safeWriteMessage({
      conversationId,
      sender: "user",
      createdAt: now,
      meta: { toolUsed: "line", text: logText, rawType, location: locationMeta },
    });

    await safeUpsertConversation({
      conversationId,
      patch: { lastMessageAt: now, updatedAt: now, lastMessageText: String(logText || "").slice(0, 120) },
    });
  } catch (err) {
    console.error("[CONVERSATION_LOG_ERROR]", err);
  }

  // ===== Location: ค้นคลินิก/รพ ใกล้ฉัน (OSM Overpass) =====
  if (rawType === "location") {
    const { latitude, longitude } = event.message || {};
    try {
      const places = await findClinicsOSM(latitude, longitude, 3000);
      if (!places.length) {
        return reply(
          event.replyToken,
          `อาริศาหาไม่เจอในรัศมีใกล้ ๆ ค่ะ 🥺 ลองขยับตำแหน่งหรือเพิ่มรัศมีได้ไหมคะ`,
          conversationId,
          { userId }
        );
      }
      const lines = places.map((p, i) => `${i + 1}) ${p.name}\n📍 ${p.map}`);
      return reply(
        event.replyToken,
        `ได้เลยค่ะ 😊 อาริศาหาที่ใกล้ ๆ ให้แล้ว (รัศมี ~3 กม.)\n\n${lines.join("\n\n")}`,
        conversationId,
        { userId }
      );
    } catch (e) {
      return reply(
        event.replyToken,
        `ขออภัยค่ะ ตอนนี้ค้นหาคลินิกใกล้ฉันไม่ได้ชั่วคราว 🥺`,
        conversationId,
        { userId }
      );
    }
  }

  if (rawType !== "text") return;

  // ===== Small talk ก่อน =====
  const smallTalk = getSmallTalkResponse(text);
  if (smallTalk) {
    await logIntent({ text, predicted: "SMALL_TALK", confidence: 1, finalAction: "SMALL_TALK", userId });
    return reply(event.replyToken, smallTalk, conversationId);
  }

  // ===== Small talk: Joke request =====
  // ถ้าผู้ใช้ขอ "เรื่องตลก/มุก" ให้ส่งมุกสั้น ๆ แบบสุ่ม (กันตอบซ้ำเป็นเทมเพลต)
  if (isJokeRequest(text)) {
    const joke = pickRandomJoke();
    await logIntent({ text, predicted: "SMALL_TALK_JOKE", confidence: 1, finalAction: "SMALL_TALK_JOKE", userId });
    return reply(event.replyToken, joke, conversationId);
  }

  // ===== Study summary (อาหาร & ยา) =====
  if (isFoodDrugStudyQuestion(text)) {
    await logIntent({ text, predicted: "STUDY_FOOD_DRUG", confidence: 1, finalAction: "STUDY_FOOD_DRUG", userId });
    return reply(event.replyToken, buildFoodDrugStudySummary(), conversationId, { kind: "study" });
  }

  const session = userSessions[userId];

  // ===== Global cancel =====
  if (session && /^ยกเลิก$/i.test(text)) {
    await logIntent({
      text,
      predicted: session.flow === "SYMPTOM_FOLLOWUP" ? "SYMPTOM_CHECK" : "APPOINTMENT_FLOW",
      confidence: 1,
      finalAction: "FLOW_CANCELLED_MIDWAY",
      userId,
    });
    delete userSessions[userId];

    if (session.flow === "SYMPTOM_FOLLOWUP") {
      return reply(
        event.replyToken,
        `รับทราบค่ะ ยกเลิกการประเมินอาการรอบนี้ให้แล้วนะคะ ✨

ถ้าต้องการเริ่มใหม่ พิมพ์อาการของคุณมาได้เลยค่ะ (เช่น "มีไข้ เจ็บคอ") 🩺`,
        conversationId
      );
    }

    return reply(
      event.replyToken,
      `ยกเลิกการนัดหมายรอบนี้ให้แล้วนะคะ ✨

หากต้องการเริ่มใหม่ สามารถพิมพ์ "นัดหมายแพทย์" ได้เลยค่ะ 🏥
ถ้าต้องการเปลี่ยนรายละเอียดบางส่วน เช่น แผนก / วันที่ / ช่วงเวลา
รอบหน้าสามารถพิมพ์คำตอบใหม่ให้ถูกต้อง หรือพิมพ์ว่า "เปลี่ยนวันที่" / "เปลี่ยนช่วงเวลา" ตามที่เหมาะสมได้เลยนะคะ 💬`,
      conversationId
    );
  }

  // ===== เริ่มประเมินอาการ (ผู้ใช้พิมพ์คำสั่ง) =====
  if (["ตรวจอาการ", "เช็คอาการ", "ประเมินอาการ", "ขอตรวจอาการ"].some((k) => text.includes(k))) {
    return reply(
      event.replyToken,
      `ได้เลยค่ะ 😊 เล่า “อาการหลัก” ที่กำลังเป็นอยู่ให้หน่อยนะคะ (เช่น ปวดหัว มีไข้ ไอ เจ็บคอ ปวดท้อง ฯลฯ)\n\nอาริศาจะใช้ AI (Ollama) ช่วยสรุปแนวทางดูแลตัวเองเบื้องต้นให้ค่ะ 🌿\n*หมายเหตุ: เป็นคำแนะนำเบื้องต้นเท่านั้น ไม่ใช่การวินิจฉัยนะคะ*`,
      conversationId,
      { userId }
    );
  }

  // ===== Symptom check (ใช้ Ollama AI แทนสคริปถามทีละข้อ) =====
  const activeSymptom = await getArisaSession(conversationId);
  if (activeSymptom?.mode === "symptom") {
    // เคยใช้ flow แบบถามทีละข้อ → ปิดทิ้ง และเคลียร์ session เก่า
    await clearArisaSession(conversationId);
  }
  if (isHealthQuestion(text)) {
    const convoIdForLLM = conversationId || getConversationIdFromLineEvent(event);
    const llmTool = ARISA_USE_OLLAMA ? "ollama" : "n8n_llm";

    try {
      const llmText = ARISA_USE_OLLAMA
        ? await arisaLLMReply({ userText: text, conversationId: convoIdForLLM, userId })
        : await callArisaLLM({ userId, text, conversationId: convoIdForLLM });

      if (llmText) {
        await logIntent({ text, predicted: "SYMPTOM_CHECK", confidence: 1, finalAction: "SYMPTOM_CHECK_OLLAMA", userId });
        return replyQuick(
          event.replyToken,
          llmText,
          [
            { label: "🏥 นัดหมายแพทย์", text: "นัดหมายแพทย์" },
            { label: "📍 หาคลินิกใกล้ฉัน", text: "คลินิกใกล้ฉัน" },
            { label: "💬 คุยเล่น", text: "สวัสดี" },
          ],
          conversationId,
          { toolUsed: llmTool, conversationId }
        );
      }
    } catch (e) {
      console.warn(`[SYMPTOM_CHECK_OLLAMA] ${llmTool} failed:`, e?.message || e);
    }

    await logIntent({ text, predicted: "SYMPTOM_CHECK", confidence: 1, finalAction: "SYMPTOM_CHECK_FAIL", userId });
    return reply(
      event.replyToken,
      "ขออภัยค่ะ ตอนนี้ AI ตอบช้า/ไม่พร้อมชั่วคราว ลองพิมพ์ใหม่อีกครั้งสักครู่นะคะ 🙏",
      conversationId
    );
  }

  // ===== Appointment flow =====
  if (session && (session.flow === "APPOINTMENT" || typeof session.step === "number")) {
    if (session.step === 1) {
      const allowed = ["อายุรกรรม", "กุมารเวช", "ศัลยกรรม"];
      if (!allowed.includes(text)) {
        await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_1_INVALID", userId });
        return reply(event.replyToken, "กรุณาระบุ **แผนกที่ถูกต้อง** เช่น อายุรกรรม, กุมารเวช, ศัลยกรรม ค่ะ 🏥", conversationId);
      }
      session.departmentTH = text;
      session.department = text;
      session.step = 2;
      await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_1_OK", userId });
      return reply(event.replyToken, "เลือก **วันที่** ที่ต้องการนัดนะคะ (เช่น 25/07/2025) 📅", conversationId);
    }

    if (session.step === 2) {
      const parsed = parseThaiDateToBangkokMidnight(text);
      if (!parsed) {
        await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_2_INVALID", userId });
        return reply(event.replyToken, `รูปแบบวันที่ไม่ถูกต้องค่ะ เช่น "25/07/2025" 📅`, conversationId);
      }
      session.dateKey = parsed.dateKey;
      session.dateAt = parsed.ts;
      session.step = 3;

      await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_2_OK", userId });
      return reply(event.replyToken, "เลือก **ช่วงเวลา** ที่ต้องการนัดค่ะ (เช้า/บ่าย) ⏰", conversationId);
    }

    if (session.step === 3) {
      const timeOptions = ["เช้า", "บ่าย"];
      if (!timeOptions.includes(text)) {
        await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_3_INVALID", userId });
        return reply(event.replyToken, "กรุณาระบุ **ช่วงเวลา** เป็น 'เช้า' หรือ 'บ่าย' เท่านั้นค่ะ ⏰", conversationId);
      }
      session.time = text;
      session.step = 4;
      await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_3_OK", userId });
      return reply(event.replyToken, "ขอ **ชื่อ-นามสกุล และเบอร์โทรติดต่อ** ด้วยค่ะ (เช่น นายตัวอย่าง คนดี / 0812345678)", conversationId);
    }

    if (session.step === 4) {
      const m = text.match(/^(.+)\s\/\s((06|08|09)\d{8})$/);
      if (!m) {
        await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_4_INVALID", userId });
        return reply(event.replyToken, "กรุณาระบุในรูปแบบ **ชื่อ-นามสกุล / เบอร์โทร** เช่น:\n\nนายตัวอย่าง คนดี / 0812345678", conversationId);
      }
      session.name = m[1].trim();
      session.phone = m[2];

      await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_4_OK", userId });

      const flex = buildApptConfirmFlex(session);
      session.step = 5;
      return replyFlex(event.replyToken, flex, conversationId, { text: "[Flex] การ์ดยืนยันนัดหมาย" });
    }

    if (session.step === 5) {
      if (/^เปลี่ยนวันที่$/i.test(text)) {
        session.step = 2;
        return reply(event.replyToken, 'กรุณาพิมพ์วันที่ใหม่ค่ะ (เช่น 25/07/2025) 📅', conversationId);
      }
      if (/^เปลี่ยนช่วงเวลา$/i.test(text)) {
        session.step = 3;
        return reply(event.replyToken, "เลือกช่วงเวลาอีกครั้งค่ะ (เช้า/บ่าย) ⏰", conversationId);
      }

      if (/^ยืนยัน$/i.test(text)) {
        try {
          const dup = await db
            .collection("appointments")
            .where("byUser", "==", userId)
            .where("dateKey", "==", session.dateKey)
            .where("session", "==", session.time)
            .where("department", "==", session.department)
            .limit(1)
            .get();

          if (!dup.empty) {
            await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "DUPLICATE_APPOINTMENT", userId });

            await replyQuick(
              event.replyToken,
              `ดูเหมือนว่าคุณมีนัดช่วงนี้อยู่แล้วค่ะ 🗓️
- วันที่: ${formatDateTH(session.dateKey)}
- ช่วง: ${session.time}
- แผนก: ${session.department}

ต้องการแก้ไขอะไรดีคะ?`,
              [
                { label: "เปลี่ยนวันที่", text: "เปลี่ยนวันที่" },
                { label: "เปลี่ยนช่วงเวลา", text: "เปลี่ยนช่วงเวลา" },
                { label: "ยกเลิก", text: "ยกเลิก" },
              ],
              conversationId
            );
            return;
          }

          const payload = {
            byUser: userId,
            department: session.department,
            dateAt: session.dateAt,
            dateKey: session.dateKey,
            session: session.time,
            name: session.name,
            contact: session.phone,
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          await db.collection("appointments").add(payload);

          await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "CONFIRMED", userId });
          delete userSessions[userId];

          const successFlex = buildApptSuccessFlex(payload);
          return replyFlex(event.replyToken, successFlex, conversationId, { text: "[Flex] นัดหมายสำเร็จแล้วค่ะ" });
        } catch (err) {
          console.error("[APPOINTMENT_SAVE_ERROR]", err);
          await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "ERROR_SAVE", userId });
          return reply(event.replyToken, "ขออภัยค่ะ เกิดข้อผิดพลาดในการบันทึกข้อมูล 😥 กรุณาลองใหม่อีกครั้ง", conversationId);
        }
      }

      await logIntent({ text, predicted: "APPOINTMENT_FLOW", confidence: 1, finalAction: "STEP_5_INVALID", userId });
      return reply(event.replyToken, "กรุณาแตะปุ่ม **ยืนยัน** หรือ **ยกเลิก** จากการ์ดนัดหมายเมื่อสักครู่ค่ะ", conversationId);
    }
  }

  // ===== Intent routing =====
  let intent = "";
  let confidence = 0;
  let finalAction = "";

  if (SYMPTOM_HINT_REGEX.test(text)) {
    intent = "SYMPTOM_CHECK";
    confidence = 1;
    finalAction = "SYMPTOM_CHECK";
  } else {
    const r = await classifyIntent(event.message.text.trim());
    intent = r.intent;
    confidence = r.confidence;
    finalAction = routeIntent(intent, confidence);

    if (
      !["APPOINTMENT", "CERTIFICATE", "HEALTH_NEWS", "HEALTH_RECORD", "SYMPTOM_CHECK", "SMALL_TALK"].includes(finalAction) &&
      SYMPTOM_HINT_REGEX.test(text)
    ) {
      finalAction = "SYMPTOM_CHECK";
    }
  }

  await logIntent({ text: event.message.text.trim(), predicted: intent, confidence, finalAction, userId: event.source.userId });

  switch (finalAction) {
    case "APPOINTMENT":
      userSessions[event.source.userId] = { flow: "APPOINTMENT", step: 1 };
      return reply(event.replyToken, "อาริศาขอทราบ **แผนกที่ต้องการนัด** ด้วยค่ะ 🏥 (เช่น อายุรกรรม, กุมารเวช, ศัลยกรรม)", conversationId);

    case "CERTIFICATE": {
      const userIdForCert = event.source.userId;
      const certUrl =
        "https://medeasehosting.web.app/requestCertificate-full.html" + "?lineUserId=" + encodeURIComponent(userIdForCert);
      return reply(event.replyToken, ["ต้องการขอใบรับรองแพทย์ใช่ไหมคะ? 🩺", "กดลิงก์ด้านล่างเพื่อกรอกข้อมูลได้เลยค่ะ 👇", certUrl].join("\n"), conversationId);
    }

    case "HEALTH_NEWS":
      return reply(event.replyToken, "📢 ข่าวสุขภาพล่าสุด: https://medeasehosting.web.app/medease-health-news.html", conversationId);

    case "HEALTH_RECORD":
      return reply(event.replyToken, "🗒️ ระบบบันทึกสุขภาพกำลังพัฒนา สามารถกรอกผ่าน LIFF ได้เร็ว ๆ นี้นะคะ", conversationId);

    case "SYMPTOM_CHECK": {
      const symptomText = event.message.text.trim();

      // red flag -> แนะนำพบแพทย์/ฉุกเฉินทันที
      if (hasRedFlags(symptomText)) {
        await logIntent({ text: symptomText, predicted: intent, confidence, finalAction: "SYMPTOM_CHECK_REDFLAG", userId });
        return reply(
          event.replyToken,
          `อาริศาเป็นห่วงนะคะ 🥺 อาการที่เล่ามาเข้าข่าย “สัญญาณอันตราย (red flag)”\n\nแนะนำให้ไปพบแพทย์/ห้องฉุกเฉิน หรือโทร 1669 ทันทีนะคะ`,
          conversationId
        );
      }

      const convoIdForLLM = conversationId || getConversationIdFromLineEvent(event);
      const llmTool = ARISA_USE_OLLAMA ? "ollama" : "n8n_llm";

      try {
        const llmText = ARISA_USE_OLLAMA
          ? await arisaLLMReply({ userText: symptomText, conversationId: convoIdForLLM, userId })
          : await callArisaLLM({ userId, text: symptomText, conversationId: convoIdForLLM });

        if (llmText) {
          await logIntent({ text: symptomText, predicted: intent, confidence, finalAction: "SYMPTOM_CHECK_OLLAMA", userId });
          return replyQuick(
            event.replyToken,
            llmText,
            [
              { label: "🏥 นัดหมายแพทย์", text: "นัดหมายแพทย์" },
              { label: "📍 หาคลินิกใกล้ฉัน", text: "คลินิกใกล้ฉัน" },
              { label: "💬 คุยเล่น", text: "สวัสดี" },
            ],
            conversationId,
            { toolUsed: llmTool, conversationId }
          );
        }
      } catch (err) {
        console.error("[SYMPTOM_CHECK_OLLAMA_ERROR]", err);
      }

      await logIntent({ text: symptomText, predicted: intent, confidence, finalAction: "SYMPTOM_CHECK_FAIL", userId });
      return reply(event.replyToken, "ขออภัยค่ะ ตอนนี้ AI ตอบช้า/ไม่พร้อมชั่วคราว ลองพิมพ์ใหม่อีกครั้งสักครู่นะคะ 🙏", conversationId);
    }

    case "SMALL_TALK":
      return reply(event.replyToken, "อาริศาพร้อมคุยด้วยเสมอค่ะ 😊 อยากถามหรือเล่าอะไรให้ฟังได้เลยน้า", conversationId);

    default: {
      // ===== Phase B: RAG (KB) for general questions =====
      // Try KB first for non-health, non-flow queries. If not found, fall back to LLM as before.
      try {
  const SYS_QUERY =
    /(medease|arisa|ฟีเจอร์|ทำอะไรได้|ทำยังไง|ใช้งาน|เมนู|นัดหมาย|ใบรับรอง|ข่าว|privacy|pdpa|สิทธิ์|admin|login|logout|ตอบซ้ำ|troubleshoot)/i.test(
      text
    );

  const healthMode = isHealthQuestion(text);

  if (!SYS_QUERY && !healthMode) {
    throw new Error("KB_SKIP_NON_SYS_QUERY");
  }

  const collectionName = healthMode ? ARISA_KB_COLLECTION_HEALTH : ARISA_KB_COLLECTION_SYSTEM;
  const kbVersion = healthMode ? ARISA_KB_VERSION_HEALTH : ARISA_KB_VERSION_SYSTEM;

  const kbHits = await arisaKbVectorSearch(text, 4, collectionName, kbVersion);

  const SYS_TOPICS = new Set([
    "about",
    "features",
    "appointments",
    "certificates",
    "news",
    "privacy",
    "troubleshoot",
    "system",
  ]);
  const HEALTH_TOPICS = new Set(["dengue", "headache", "fever_u5", "safety"]);

  const allow = healthMode ? HEALTH_TOPICS : SYS_TOPICS;
  const kbHitsUsed = (kbHits || []).filter((h) =>
    allow.has(String(h.topic || "").toLowerCase())
  );

  const top = kbHitsUsed && kbHitsUsed[0] ? kbHitsUsed[0] : null;

  try {
    console.log(
      `[KB_RAG] mode=${healthMode ? "health" : "system"} collection=${collectionName} version=${kbVersion}`
    );
    console.log(
      `[KB_RAG] hits=${kbHitsUsed.length} topId=${top ? top.id : "(none)"} topTopic=${top ? top.topic : "(none)"}`
    );
  } catch (_) {}

  const kbReply = buildArisaKbReplyShort(text, kbHitsUsed);
  if (kbReply) {
    return reply(event.replyToken, kbReply, conversationId);
  }

  throw new Error("KB_NO_HIT");
} catch (e) {
        // never crash: fallback to LLM
        if ((e?.message || "") !== "KB_SKIP_NON_SYS_QUERY") {
        const _m = String(e?.message || e || "");
        if (_m.includes("FAILED_PRECONDITION") && _m.includes("vector index")) {
          // quiet: vector index missing; keyword fallback (or LLM) will handle
        } else {
          console.warn("[KB_RAG] failed -> fallback:", e?.message || e);
        }
      }
      }

      // LLM fallback: n8n -> ollama -> menu
      const fallbackQuick = [
        { label: "🩺 เช็กอาการ", text: "เช็กอาการ" },
        { label: "🏥 นัดหมายแพทย์", text: "นัดหมายแพทย์" },
        { label: "📄 ขอใบรับรอง", text: "ขอใบรับรองแพทย์" },
        { label: "📢 ข่าวสุขภาพ", text: "ข่าวสุขภาพ" },
        { label: "💬 คุยเล่น", text: "สวัสดี" },
      ];

      const convoIdForLLM = conversationId || getConversationIdFromLineEvent(event);
      const llmTool = ARISA_USE_OLLAMA ? "ollama" : "n8n_llm";

      try {
        const llmText = ARISA_USE_OLLAMA
          ? await arisaLLMReply({ userText: text, conversationId: convoIdForLLM, userId })
          : await callArisaLLM({ userId, text, conversationId: convoIdForLLM });
        if (llmText) {
          return replyQuick(event.replyToken, llmText, fallbackQuick, conversationId, { toolUsed: llmTool, conversationId });
        }
      } catch (e) {
        console.warn(`[LLM_FALLBACK] ${llmTool} failed:`, e?.message || e);
      }

      try {
        const oText = await callOllamaLLM({ userId, text, conversationId: convoIdForLLM });
        if (oText) {
          return replyQuick(event.replyToken, oText, fallbackQuick, conversationId, { toolUsed: "ollama_llm", conversationId });
        }
      } catch (e) {
        console.warn("[LLM_FALLBACK] ollama failed -> menu:", e?.message || e);
      }

      return replyQuick(
        event.replyToken,
        "อาริศายังไม่แน่ใจว่าคุณต้องการเรื่องไหนค่ะ 😊 เลือกเมนูได้เลยนะคะ",
        fallbackQuick,
        conversationId,
        { toolUsed: "default_menu", conversationId }
      );
    }
  }
}

// ===== Helper: ดึง LINE userId จากเอกสารนัดหมาย (รองรับหลายสคีม่า) =====
function pickLineUserIdFromAppt(appt) {
  const candidates = [
    appt?.lineUserId, // สคีม่าใหม่ (หน้า admin CRUD)
    appt?.byUser, // สคีม่าเดิม (แชทบอท/Flow เก่า)
    appt?.userId, // บางเคสอาจเก็บเป็น LINE userId
    appt?.line_user_id, // กันพัง
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("U")) return c;
  }
  return null;
}

function pickDateStrFromAppt(appt) {
  if (!appt) return "";
  if (typeof appt.dateStr === "string" && appt.dateStr.trim()) return appt.dateStr.trim();
  if (typeof appt.dateKey === "string" && appt.dateKey.trim()) return formatDateTH(appt.dateKey) || appt.dateKey.trim();

  // รองรับ timestamp: dateAt / date
  const ts = appt.dateAt || appt.date;
  if (ts && typeof ts.toDate === "function") {
    const d = ts.toDate();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear());
    return `${dd}/${mm}/${yy}`;
  }
  return "";
}

// ========== Admin API: appointments ==========

app.post("/admin/appointments/:id/confirm-and-notify", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const ref = db.doc(`appointments/${id}`);

    // อัปเดตสถานะก่อน (ให้ CRUD สำเร็จแม้ส่ง LINE ไม่ได้)
    await ref.update({ status: "confirmed", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const snap = await ref.get();
    const appt = snap.data() || {};

    const lineUserId = pickLineUserIdFromAppt(appt);
    const dateStr = pickDateStrFromAppt(appt);

    let notified = false;
    let notifyError = null;

    if (lineUserId) {
      try {
        await pushApptUpdate(lineUserId, {
          status: "confirmed",
          department: appt.department,
          dateStr,
          session: appt.session,
        });
        notified = true;
      } catch (e) {
        notifyError = e?.message || String(e);
        console.warn("[APPT_NOTIFY_WARN] confirm:", notifyError);
      }
    } else {
      notifyError = "missing LINE userId (lineUserId/byUser)";
      console.warn("[APPT_NOTIFY_WARN] confirm: missing LINE userId in appointment doc:", id);
    }

    await db.collection("intent_logs").add({
      intent: "APPOINTMENT",
      action: "CONFIRM",
      apptId: id,
      by: "admin-web",
      notified,
      notifyError: notifyError || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ ok: true, notified, notifyError });
  } catch (err) {
    console.error("[CONFIRM_AND_NOTIFY_ERROR]", err);
    res.status(500).json({ ok: false, error: err?.message || "unknown" });
  }
});

// PATCH: admin-appointments helper endpoint (confirm only, no LINE notify)
app.post("/admin/appointments/:id/confirm", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: "missing id" });

    await db.collection("appointments").doc(id).set(
      {
        status: "confirmed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[admin/appointments/confirm] error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "unknown" });
  }
});

app.post("/admin/appointments/:id/cancel", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const ref = db.doc(`appointments/${id}`);

    await ref.update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const snap = await ref.get();
    const appt = snap.data() || {};

    const lineUserId = pickLineUserIdFromAppt(appt);
    const dateStr = pickDateStrFromAppt(appt);

    let notified = false;
    let notifyError = null;

    if (lineUserId) {
      try {
        await pushApptUpdate(lineUserId, {
          status: "cancelled",
          department: appt.department,
          dateStr,
          session: appt.session,
        });
        notified = true;
      } catch (e) {
        notifyError = e?.message || String(e);
        console.warn("[APPT_NOTIFY_WARN] cancel:", notifyError);
      }
    } else {
      notifyError = "missing LINE userId (lineUserId/byUser)";
      console.warn("[APPT_NOTIFY_WARN] cancel: missing LINE userId in appointment doc:", id);
    }

    await db.collection("intent_logs").add({
      intent: "APPOINTMENT",
      action: "CANCEL",
      apptId: id,
      by: "admin-web",
      notified,
      notifyError: notifyError || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ ok: true, notified, notifyError });
  } catch (err) {
    console.error("[CANCEL_ERROR]", err);
    res.status(500).json({ ok: false, error: err?.message || "unknown" });
  }
});

app.post("/admin/appointments/:id/reschedule", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const ref = db.doc(`appointments/${id}`);

    await ref.update({ status: "rescheduled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const snap = await ref.get();
    const appt = snap.data() || {};

    const lineUserId = pickLineUserIdFromAppt(appt);
    const dateStr = pickDateStrFromAppt(appt);

    let notified = false;
    let notifyError = null;

    if (lineUserId) {
      try {
        await pushApptUpdate(lineUserId, {
          status: "rescheduled",
          department: appt.department,
          dateStr,
          session: appt.session,
        });
        notified = true;
      } catch (e) {
        notifyError = e?.message || String(e);
        console.warn("[APPT_NOTIFY_WARN] reschedule:", notifyError);
      }
    } else {
      notifyError = "missing LINE userId (lineUserId/byUser)";
      console.warn("[APPT_NOTIFY_WARN] reschedule: missing LINE userId in appointment doc:", id);
    }

    await db.collection("intent_logs").add({
      intent: "APPOINTMENT",
      action: "RESCHEDULE",
      apptId: id,
      by: "admin-web",
      notified,
      notifyError: notifyError || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ ok: true, notified, notifyError });
  } catch (err) {
    console.error("[RESCHEDULE_ERROR]", err);
    res.status(500).json({ ok: false, error: err?.message || "unknown" });
  }
});

// ========== User API: ขอใบรับรองแพทย์ ==========
app.post("/certificates/request", async (req, res) => {
  try {
    const { lineUserId, fullName, idcard, email, phone, symptoms, patientType, displayName } = req.body || {};

    if (!lineUserId || !fullName || !idcard) {
      return res.status(400).json({ ok: false, error: "missing lineUserId/fullName/idcard" });
    }

    const ref = db.collection("certificates_requests").doc();
    await ref.set({
      lineUserId,
      fullname: fullName,
      displayName: displayName || null,
      idcard,
      email: email || null,
      phone: phone || null,
      symptoms: symptoms || "",
      patientType: patientType || "",
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    console.error("[CERT_REQUEST]", e);
    return res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
});

// ========== Admin API: ใบรับรองแพทย์ ==========
app.post("/admin/certificates/:id/approve", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const ref = db.collection("certificates_requests").doc(id);
    const snap = await ref.get();

    if (!snap.exists) return res.status(404).json({ ok: false, error: "not found" });

    const data = snap.data();

    await ref.update({
      status: "approved",
      approvedBy: req.user?.email || req.user?.uid || "admin",
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const baseUrl = (process.env.CERT_BASE_URL || "").replace(/\/+$/, "");
    const downloadUrl = `${baseUrl}/certificates/${id}/download`;

    try {
      console.log("[CERT_APPROVE] lineUserId =", data.lineUserId);
      console.log("[CERT_APPROVE] downloadUrl =", downloadUrl);

      if (data.lineUserId && baseUrl) {
        const msg = { type: "text", text: `ใบรับรองแพทย์ของคุณได้รับการอนุมัติแล้วค่ะ\nดาวน์โหลด: ${downloadUrl}` };
        await lineClient.pushMessage(data.lineUserId, msg);
        console.log("[CERT_APPROVE] pushMessage OK ✅");
      } else {
        console.warn("[CERT_APPROVE] skip pushMessage because lineUserId/baseUrl missing", { lineUserId: data.lineUserId, baseUrl });
      }
    } catch (err) {
      console.error("===== LINE PUSH ERROR =====");
      console.error("TYPE        :", err.name);
      console.error("CODE        :", err.code);
      console.error("HTTP_STATUS :", err.response?.status, err.response?.statusText);
      console.error("LINE_BODY   :", JSON.stringify(err.response?.data || {}, null, 2));
      console.error("HEADERS     :", JSON.stringify(err.response?.headers || {}, null, 2));
      console.error("REQUEST_ID  :", err.response?.headers?.["x-line-request-id"]);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[CERT_APPROVE_ROUTE_ERROR]", e);
    return res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
});

app.post("/admin/certificates/:id/update", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { doctorName, daysOff, diagnosis, symptoms, patientType } = req.body || {};

    const ref = db.collection("certificates_requests").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "not found" });

    const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (doctorName !== undefined) updateData.doctorName = doctorName;
    if (daysOff !== undefined) updateData.daysOff = daysOff;
    if (diagnosis !== undefined) updateData.diagnosis = diagnosis;
    if (symptoms !== undefined) updateData.symptoms = symptoms;
    if (patientType !== undefined) updateData.patientType = patientType;

    await ref.update(updateData);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[CERT_UPDATE]", e);
    return res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
});

app.post("/admin/certificates/:id/delete", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const ref = db.collection("certificates_requests").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "not found" });

    await ref.delete();
    return res.json({ ok: true });
  } catch (e) {
    console.error("[CERT_DELETE]", e);
    return res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
});

app.post("/admin/certificates/:id/reject", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const reason = req.body?.reason || "ไม่ผ่านการอนุมัติ";

    const ref = db.collection("certificates_requests").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "not found" });

    const data = snap.data();

    await ref.update({ status: "rejected", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    if (data.lineUserId) {
      await lineClient.pushMessage(data.lineUserId, { type: "text", text: "คำร้องใบรับรองแพทย์ของคุณไม่ได้รับการอนุมัติค่ะ ❌\nเหตุผล: " + reason });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[CERT_REJECT]", e);
    return res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
});

// ========== Public download ==========
app.get("/certificates/:id/download", async (req, res) => {
  try {
    const id = req.params.id;
    const ref = db.collection("certificates_requests").doc(id);
    const snap = await ref.get();

    if (!snap.exists) return res.status(404).type("text").send("ไม่พบคำร้องใบรับรองนี้");
    const data = snap.data();

    if (data.status !== "approved") {
      return res.status(403).type("text").send("ใบรับรองยังไม่ได้รับการอนุมัติ หรือไม่พร้อมให้ดาวน์โหลดค่ะ");
    }

    const pdfBytes = await buildCertificatePdfBytes({
      fullName: data.fullname || data.fullName,
      idcard: data.idcard,
      patientType: data.patientType,
      symptoms: data.symptoms,
      doctorName: data.approvedBy || "MedEase Doctor",
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="medical-certificate-${id}.pdf"`);
    return res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error("[CERT_DOWNLOAD]", e);
    return res.status(500).type("text").send("เกิดข้อผิดพลาดในการสร้างใบรับรองแพทย์");
  }
});

// ========== Cron endpoints: ตารางเวรแพทย์ ==========
app.post("/cron/doctor-tomorrow-summary", async (req, res) => {
  try {
    const v = verifyCronKey(req);
    if (!v.ok) return res.status(v.status).json({ ok: false, error: v.error });

    const result = await sendDoctorTomorrowSummary();
    return res.json(result);
  } catch (err) {
    console.error("[CRON] /cron/doctor-tomorrow-summary error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal error" });
  }
});

// PATCH: กัน endpoint ซ้ำ (ให้เป็น 410 Gone ชัด ๆ)
app.post("/cron/doctor-upcoming-reminder", async (req, res) => {
  return res.status(410).json({ ok: false, error: "gone", message: "Use POST /cron/doctor-upcoming-reminders (note the trailing s)." });
});

// ✅ endpoint เดียวที่ใช้จริง
app.post("/cron/doctor-upcoming-reminders", async (req, res) => {
  try {
    const v = verifyCronKey(req);
    if (!v.ok) return res.status(v.status).json({ ok: false, error: v.error });

    const result = await sendUpcomingShiftReminders();
    return res.json(result);
  } catch (err) {
    console.error("[CRON] /cron/doctor-upcoming-reminders error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "error" });
  }
});

// ===== Bootstrap (PATCH: remove top-level await) =====
async function bootstrap() {
  await loadIntentSamples();

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
  });
}

bootstrap().catch((e) => {
  console.error("[BOOTSTRAP] fatal:", e);
  process.exit(1);
});