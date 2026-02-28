// file: apps/api/src/intent.js
// ===== Simple Intent Engine for Arisa =====
// PATCH(2026-02-25 Phase A):
// - remove any risky debug refs (e.g., undefined variables in logs)
// - harden classifyIntent() to never throw (safe fallback UNKNOWN)
// - sanitize confidence input in routeIntent()

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// เผื่ออนาคตอยากใช้ไฟล์เทรน เช่น intent-samples.json
let intentSamples = [];

// รายชื่อ intent ที่อนุญาต
export const ALLOWED_INTENTS = [
  "APPOINTMENT",
  "CERTIFICATE",
  "HEALTH_NEWS",
  "HEALTH_RECORD",
  "SYMPTOM_CHECK",
  "SMALL_TALK",
];

// ===== Regex เบื้องต้นสำหรับเดา intent =====
const RE_APPOINTMENT =
  /(นัดหมายแพทย์|ขอนัดหมอ|จองคิวหมอ|อยากนัดหมอ|นัดหมอ|อยากพบหมอ|ขอพบแพทย์)/i;

const RE_CERTIFICATE =
  /(ใบรับรองแพทย์|ขอใบรับรอง|ใบลาโรงเรียน|ใบลางาน|ต้องใช้ใบรับรอง|certificate)/i;

const RE_HEALTH_NEWS =
  /(ข่าวสุขภาพ|อัปเดตสุขภาพ|ข่าวโควิด|บทความสุขภาพ|health news)/i;

const RE_HEALTH_RECORD =
  /(บันทึกสุขภาพ|จดสุขภาพ|เพิ่มประวัติสุขภาพ|health record)/i;

// แคบลง: ตัดคำกว้าง ๆ อย่าง "ป่วย/ไม่สบาย" ออก แล้วให้ index.js เป็นตัวตัดสิน healthMode แทน
const RE_SYMPTOM =
  /(เช็กอาการ|ตรวจอาการ|ประเมินอาการ|เป็นอะไรดี|ฉันเป็นอะไร|สงสัยว่าเป็นอะไร|มีไข้|ไข้|ไอ|เจ็บคอ|เวียนหัว|หน้ามืด|แน่นหน้าอก|หายใจไม่ออก|ปวดหัว|ปวดท้อง|ท้องเสีย|คลื่นไส้|อาเจียน)/i;

// ===== โหลด intent samples (ถ้ามีไฟล์) =====
export async function loadIntentSamples() {
  const p = path.join(__dirname, "intent-samples.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    intentSamples = JSON.parse(raw);
    console.log("[INTENT] loaded intent-samples.json:", intentSamples.length);
  } catch (err) {
    console.warn("[INTENT] no intent-samples.json, use regex only");
    intentSamples = [];
  }
}

/**
 * เดา intent จากข้อความ
 * @param {string} text
 * @returns {{ intent: string, confidence: number }}
 */
export async function classifyIntent(text) {
  try {
    const raw = (text || "").toString().trim();
    const lower = raw.toLowerCase();

    // log แบบปลอดภัย (ห้ามอ้างตัวแปรที่ไม่ประกาศ)
    try {
      console.log("[INTENT][classify] text=", raw.slice(0, 120));
    } catch {}

    if (!raw) {
      return { intent: "UNKNOWN", confidence: 0.0 };
    }

    // 1) เดาจาก regex ก่อน (rule-based)
    if (RE_APPOINTMENT.test(lower)) return { intent: "APPOINTMENT", confidence: 0.95 };
    if (RE_CERTIFICATE.test(lower)) return { intent: "CERTIFICATE", confidence: 0.95 };
    if (RE_HEALTH_NEWS.test(lower)) return { intent: "HEALTH_NEWS", confidence: 0.9 };
    if (RE_HEALTH_RECORD.test(lower)) return { intent: "HEALTH_RECORD", confidence: 0.9 };
    if (RE_SYMPTOM.test(lower)) return { intent: "SYMPTOM_CHECK", confidence: 0.92 };

    // 2) ถ้ามี intentSamples ก็ลองเทียบแบบง่าย ๆ (optional)
    if (intentSamples.length > 0) {
      let best = { intent: "UNKNOWN", score: 0 };
      for (const sample of intentSamples) {
        const sText = (sample.text || "").toLowerCase();
        if (!sText) continue;

        // similarity แบบโง่ ๆ: นับว่าข้อความ sample ถูก include หรือไม่
        if (lower.includes(sText)) {
          const score = (sample.weight || 1) * sText.length;
          if (score > best.score && ALLOWED_INTENTS.includes(sample.intent)) {
            best = { intent: sample.intent, score };
          }
        }
      }
      if (best.intent !== "UNKNOWN") {
        return { intent: best.intent, confidence: 0.8 };
      }
    }

    // 3) ถ้าเดาไม่ได้จริง ๆ
    return { intent: "UNKNOWN", confidence: 0.3 };
  } catch (err) {
    // กันระบบล่ม: intent engine พัง -> UNKNOWN ทันที
    console.warn("[INTENT][classify] error -> fallback UNKNOWN:", err?.message || err);
    return { intent: "UNKNOWN", confidence: 0.0 };
  }
}

/**
 * routeIntent – ตัดสินว่าจะให้บอทไป flow ไหนจริง ๆ
 * @param {string} intent
 * @param {number} confidence
 * @returns {string} finalAction
 */
export function routeIntent(intent, confidence) {
  const c = Number(confidence);
  const safeConfidence = Number.isFinite(c) ? c : 0;

  // ถ้าไม่อยู่ใน ALLOWED หรือเชื่อมั่นน้อย ให้ถือว่า UNKNOWN
  if (!ALLOWED_INTENTS.includes(intent) || safeConfidence < 0.7) {
    return "UNKNOWN";
  }
  return intent;
}
