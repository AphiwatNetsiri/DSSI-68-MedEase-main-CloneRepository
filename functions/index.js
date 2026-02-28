// functions/index.js  (Cloud Functions API สำหรับใบรับรองแพทย์)

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// ===== Init Firebase Admin =====
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// ===== Express app =====
const app = express();

// CORS เปิดให้เรียกจากเว็บ medEase ได้
app.use(cors({ origin: true }));
app.use(express.json());

// ===== Middleware: ตรวจสิทธิ์ Admin จาก Firebase Auth =====
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/i);
    if (!m) {
      return res.status(401).json({ error: "missing token" });
    }

    const decoded = await admin.auth().verifyIdToken(m[1]);

    // ใช้ custom claim admin / role == 'admin'
    if (decoded.admin === true || decoded.role === "admin") {
      req.user = decoded;
      return next();
    }

    return res.status(403).json({ error: "forbidden" });
  } catch (err) {
    console.error("[AUTH ERROR]", err);
    return res.status(401).json({ error: "invalid token" });
  }
}

// ===== Helper: สร้าง PDF ใบรับรองแพทย์ แบบสด ๆ =====
async function buildCertificatePdfBytes(data) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const { width, height } = page.getSize();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const draw = (text, x, y, size = 12) => {
    page.drawText(String(text ?? ""), {
      x,
      y,
      size,
      font,
      color: rgb(0, 0, 0),
    });
  };

  // Header
  draw("ใบรับรองแพทย์ (Medical Certificate)", 140, height - 60, 16);

  let y = height - 110;
  const line = (label, value) => {
    draw(`${label}: ${value || "-"}`, 60, y);
    y -= 22;
  };

  line("ชื่อ-สกุล", data.fullname || data.fullName);
  line("เลขประจำตัวประชาชน", data.idcard);
  line("ประเภทผู้ป่วย", data.patientType || "-");
  line("อาการ/ข้อวินิจฉัย", data.symptoms || "-");
  line("แพทย์ผู้ออกใบรับรอง", data.doctorName || "-");
  line(
    "ออก ณ วันที่",
    new Date().toLocaleDateString("th-TH", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
  );

  draw("ลงชื่อแพทย์ผู้ตรวจ ____________________", 60, y - 10);

  return await pdf.save();
}

// ====== ROUTES ======

// 1) ผู้ใช้ส่งคำร้องขอใบรับรองแพทย์ (จาก LIFF)
//    POST /api/certificates/request
app.post("/api/certificates/request", async (req, res) => {
  try {
    const {
      lineUserId,
      fullName,
      idcard,
      email,
      phone,
      symptoms,
      patientType,
    } = req.body || {};

    if (!lineUserId || !fullName || !idcard) {
      return res
        .status(400)
        .json({ ok: false, error: "missing lineUserId/fullName/idcard" });
    }

    const ref = db.collection("certificates_requests").doc(); // auto-id
    await ref.set({
      lineUserId,
      fullname: fullName,
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
    return res
      .status(500)
      .json({ ok: false, error: e.message || "internal error" });
  }
});

// 2) แอดมินกด “อนุมัติ” ในหน้า admin
//    POST /api/admin/certificates/:id/approve
app.post(
  "/api/admin/certificates/:id/approve",
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const ref = db.collection("certificates_requests").doc(id);
      const snap = await ref.get();

      if (!snap.exists) {
        return res.status(404).json({ ok: false, error: "not found" });
      }

      await ref.update({
        status: "approved",
        approvedBy: req.user?.email || req.user?.uid || "admin",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error("[CERT_APPROVE]", e);
      return res
        .status(500)
        .json({ ok: false, error: e.message || "internal error" });
    }
  }
);

// 3) แอดมิน “ไม่อนุมัติ”
//    POST /api/admin/certificates/:id/reject
app.post(
  "/api/admin/certificates/:id/reject",
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const reason = req.body?.reason || "ไม่ผ่านการอนุมัติ";

      const ref = db.collection("certificates_requests").doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ ok: false, error: "not found" });
      }

      await ref.update({
        status: "rejected",
        rejectReason: reason,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (ตอนนี้ยังไม่ push LINE / ส่งเมล – ทำทีหลังได้)
      return res.json({ ok: true });
    } catch (e) {
      console.error("[CERT_REJECT]", e);
      return res
        .status(500)
        .json({ ok: false, error: e.message || "internal error" });
    }
  }
);

// 4) ผู้ใช้ดาวน์โหลดไฟล์ใบรับรอง (หลังอนุมัติแล้ว)
//    GET /api/certificates/:id/download
app.get("/api/certificates/:id/download", async (req, res) => {
  try {
    const id = req.params.id;
    const ref = db.collection("certificates_requests").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).type("text").send("ไม่พบคำร้องใบรับรองนี้");
    }

    const data = snap.data();

    if (data.status !== "approved") {
      return res
        .status(403)
        .type("text")
        .send("ใบรับรองยังไม่ได้รับการอนุมัติ หรือไม่พร้อมให้ดาวน์โหลดค่ะ");
    }

    const pdfBytes = await buildCertificatePdfBytes({
      fullname: data.fullname,
      idcard: data.idcard,
      patientType: data.patientType,
      symptoms: data.symptoms,
      doctorName: data.approvedBy || "MedEase Doctor",
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="medical-certificate-${id}.pdf"`
    );

    return res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error("[CERT_DOWNLOAD]", e);
    return res
      .status(500)
      .type("text")
      .send("เกิดข้อผิดพลาดในการสร้างใบรับรองแพทย์");
  }
});

// สุดท้าย export Express app เป็น Cloud Function
exports.medeaseApi = functions
  .region("asia-southeast1") // เปลี่ยนเป็น region ของ Firestore ถ้าใช้ region อื่น
  .https.onRequest(app);
