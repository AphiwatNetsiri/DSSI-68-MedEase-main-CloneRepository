// admin.js  ✅ เวอร์ชันแก้แล้ว
import express from "express";
import admin from "firebase-admin";

const router = express.Router();
const db = admin.firestore();

// TODO: ตรวจสิทธิ์แอดมินจริงก่อน (เช่นตรวจ JWT/Session)
//    ที่นี่เป็นตัวอย่างสั้นเพื่อเดโม

// อนุมัติ (status -> confirmed) + อัปเดตเวลา
router.post("/appointments/:id/confirm", async (req, res) => {
  const { id } = req.params;
  await db.doc(`appointments/${id}`).update({
    status: "confirmed",
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // แจ้งผู้ใช้ผ่าน LINE (อ่าน userId จากเอกสาร)
  const snap = await db.doc(`appointments/${id}`).get();
  const appt = snap.data();
  if (appt?.userId) {
    // คุณมี lineClient อยู่ใน index.js — เราจะยิงผ่าน webhook กลางแทน (ดูข้อ 2)
    // ส่งงานต่อให้ endpoint ภายใน หรือ export ฟังก์ชัน push จาก index.js มาก็ได้
  }

  res.json({ ok: true });
});

// ยกเลิกโดยแอดมิน
router.post("/appointments/:id/cancel", async (req, res) => {
  const { id } = req.params;
  await db.doc(`appointments/${id}`).update({
    status: "cancelled",
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ ok: true });
});

// เปลี่ยนเป็นรอโทรนัดใหม่ (ตัวอย่าง reschedule)
router.post("/appointments/:id/reschedule", async (req, res) => {
  const { id } = req.params;
  await db.doc(`appointments/${id}`).update({
    status: "rescheduled",
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ ok: true });
});

export default router;
