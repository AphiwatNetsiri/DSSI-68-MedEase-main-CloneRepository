// E:\DSSI-68-MedEase-main\symptom.js

import fetch from "node-fetch";

console.log("[INFERMEDICA_ENV]", {
  HAS_APP_ID: !!process.env.INFERMEDICA_APP_ID,
  KEY_LEN: process.env.INFERMEDICA_APP_KEY?.length || 0,
  API_URL: process.env.INFERMEDICA_API_URL,
});


const API_URL =
  process.env.INFERMEDICA_API_URL || "https://api.infermedica.com/v3";

// helper เรียก Infermedica แบบรวม ๆ
async function infermedicaFetch(path, body) {
  const APP_ID = process.env.INFERMEDICA_APP_ID;
  const APP_KEY = process.env.INFERMEDICA_APP_KEY;

  if (!APP_ID || !APP_KEY) {
    throw new Error(
      "[INFERMEDICA] Missing INFERMEDICA_APP_ID / INFERMEDICA_APP_KEY in env"
    );
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "App-Id": APP_ID,
      "App-Key": APP_KEY,
      "Content-Type": "application/json",
      "Accept-Language": "en", // ใช้ en แล้วค่อยแปลตอบเป็นไทยฝั่งบอท
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[INFERMEDICA] ${path} error: ${res.status} ${res.statusText} ${text}`
    );
  }

  return res.json();
}

/**
 * triage – ประเมินอาการจากข้อความผู้ใช้
 * index.js จะเรียกใช้แล้วเอาผลไปสรุปเป็นข้อความตอบผู้ใช้
 *
 * @param {Object} params
 * @param {string} params.text  ข้อความอาการที่ผู้ใช้พิมพ์
 * @param {number} params.age   อายุ (ตัวเลข)
 * @param {string} params.sex   "male" หรือ "female"
 * @returns {Promise<{triage:any, diagnosis:any, evidence:any[]}>}
 */
export async function triage({ text, age, sex }) {
  const safeText = (text || "").toString().trim();
  if (!safeText) {
    throw new Error("No symptom text provided");
  }

  const ageVal = Number(age) || 30;
  const sexVal = sex === "female" ? "female" : "male";

  // 1) parse text → mentions/evidence
  const parsePayload = {
    text: safeText,
    age: { value: ageVal },
    sex: sexVal,
  };

  const parseResult = await infermedicaFetch("/parse", parsePayload);
  const mentions = Array.isArray(parseResult.mentions)
    ? parseResult.mentions
    : [];

  const evidence = mentions.map((m) => ({
    id: m.id,
    choice_id: m.choice_id || "present",
    source: "initial",
  }));

  // ถ้า Infermedica หา evidence ไม่เจอ → ให้ index.js ไปบอกผู้ใช้ให้พิมพ์ละเอียดขึ้น
  if (!evidence.length) {
    return {
      triage: { level: "no_evidence" },
      diagnosis: { conditions: [] },
      evidence: [],
    };
  }

  // 2) diagnosis – หาโรค/ภาวะที่เป็นไปได้
  const diagnosisPayload = {
    sex: sexVal,
    age: { value: ageVal },
    evidence,
  };
  const diagnosis = await infermedicaFetch("/diagnosis", diagnosisPayload);

  // 3) triage – ระดับความเร่งด่วน
  const triagePayload = {
    sex: sexVal,
    age: { value: ageVal },
    evidence,
  };
  const triageResult = await infermedicaFetch("/triage", triagePayload);

  return {
    triage: triageResult,
    diagnosis,
    evidence,
  };
}
