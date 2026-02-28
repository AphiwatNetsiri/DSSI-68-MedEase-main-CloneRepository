// scripts/set-role.js
import admin from "firebase-admin";
import { readFileSync } from "fs";

// แก้ path ให้ตรงกับไฟล์ serviceAccount ของโปรเจกต์คุณ
const serviceAccount = JSON.parse(
  readFileSync("./serviceAccountKey.json", "utf8")
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// ฟังก์ชันตั้ง role
async function setUserRole(uid, role) {
  const claims = {};

  if (role === "admin") {
    claims.role = "admin";
    claims.admin = true;
  } else if (role === "staff") {
    claims.role = "staff";
    claims.staff = true;
  } else if (role === "doctor") {
    claims.role = "doctor";
    claims.doctor = true;
  } else {
    throw new Error(`Unknown role: ${role}`);
  }

  await admin.auth().setCustomUserClaims(uid, claims);
  console.log(`✅ Set role="${role}" for uid="${uid}"`);
}

// ใช้แบบ: node scripts/set-role.js <uid> <role>
const [,, uid, role] = process.argv;

if (!uid || !role) {
  console.error("Usage: node scripts/set-role.js <uid> <admin|staff|doctor>");
  process.exit(1);
}

setUserRole(uid, role)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
