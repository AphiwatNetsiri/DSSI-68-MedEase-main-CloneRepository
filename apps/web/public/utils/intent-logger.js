// utils/intent-logger.js  (ESM, server-side only)
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// โหลด .env จากรากโปรเจกต์ (ขึ้นจาก utils ไป 1 ชั้น)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

let firestore = null;
try {
  if (!admin.apps.length) admin.initializeApp(); // ใช้ GOOGLE_APPLICATION_CREDENTIALS จาก .env
  firestore = admin.firestore();
} catch (e) {
  console.error('❌ Firebase Admin init failed:', e?.message || e);
}

/** บันทึก intent log ลง Firestore */
export async function logIntent({ text, predicted, confidence, finalAction, userId }) {
  try {
    if (!firestore) {
      console.warn('⚠️ Firestore not ready. Skip logging this event.');
      return;
    }
    const safeText = String(text ?? '').slice(0, 1000);
    const intent   = String(predicted ?? 'FALLBACK').trim().toUpperCase();
    const action   = String(finalAction ?? intent).trim().toUpperCase();
    const conf     = Math.max(0, Math.min(1, Number(confidence ?? 0)));
    const uid      = String(userId ?? 'UNKNOWN');

    await firestore.collection('intent_logs').add({
      text: safeText,
      predicted: intent,
      confidence: conf,
      final_action: action,
      userId: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('❌ logIntent failed:', e?.message || e);
  }
}
