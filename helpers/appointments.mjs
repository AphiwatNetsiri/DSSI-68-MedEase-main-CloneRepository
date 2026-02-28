// helpers/appointments.js
import { doc, getDoc, setDoc, serverTimestamp, Timestamp } from "firebase/firestore";

export function buildUniqKey({ dateStr, session, department, userId }) {
  // dateStr รูปแบบ YYYY-MM-DD
  return `${dateStr}-${session}-${department}-${userId}`;
}

export async function createAppointmentIfNotExists(db, payload) {
  // payload = { userId, byUser, department, dateStr, dateTs, session, name, contact }
  const uniqKey = buildUniqKey({
    dateStr: payload.dateStr,
    session: payload.session,
    department: payload.department,
    userId: payload.userId
  });
  const ref = doc(db, "appointments", uniqKey);

  const snap = await getDoc(ref);
  if (snap.exists()) {
    return { ok: false, reason: "DUPLICATE", id: uniqKey };
  }
  await setDoc(ref, {
    ...payload,
    date: payload.dateTs instanceof Timestamp ? payload.dateTs : Timestamp.fromDate(new Date(payload.dateTs)),
    status: "pending",
    createdAt: serverTimestamp(),
    uniqKey
  });
  return { ok: true, id: uniqKey };
}

// ส่งสรุป + ปุ่ม quick reply (ใช้ก่อนบันทึก)
export function buildAppointmentSummaryMessage({ department, dateStr, session, name, contact, dateISO }) {
  const lines = [
    "นัดหมายดังนี้ค่ะ",
    `- แผนก: ${department}`,
    `- วันที่: ${dateStr} (${dateISO})`,
    `- ช่วง: ${session === "morning" ? "เช้า (morning)" : "บ่าย (afternoon)"}`,
    `- ติดต่อ: ${name} / ${contact}`
  ].join("\n");

  return {
    type: "text",
    text: lines + "\n\nยืนยันการนัดหมายไหมคะ?",
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "✅ ยืนยัน",
            data: "type=appt_confirm"
                + `&department=${encodeURIComponent(department)}`
                + `&dateStr=${encodeURIComponent(dateStr)}`
                + `&session=${encodeURIComponent(session)}`
                + `&name=${encodeURIComponent(name)}`
                + `&contact=${encodeURIComponent(contact)}`
          }
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "❌ ยกเลิก",
            data: "type=appt_cancel"
          }
        }
      ]
    }
  };
}
