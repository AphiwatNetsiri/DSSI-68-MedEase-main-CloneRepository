const admin = require("firebase-admin");
const serviceAccount = require("./medeasehosting-firebase-adminsdk-fbsvc-aa2b7a26fb.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ✅ รายชื่อ UID ที่ต้องการให้เป็นแอดมิน
const adminUIDs = [
  "HCuP2qjjsuWJbRbHTM2L6B3WHKr1",
  "wo5KR57BF2TYGuDxcRyiUQPbb593"
];

// ✅ ตั้ง admin ให้ทุก UID
Promise.all(
  adminUIDs.map(uid =>
    admin.auth().setCustomUserClaims(uid, { admin: true })
      .then(() => console.log(`✅ตั้ง admin สำเร็จสำหรับ UID: ${uid}`))
      .catch(err => console.error(`❌ล้มเหลวที่ UID: ${uid}`, err))
  )
).then(() => {
  console.log("ตั้งสิทธิ์ admin เสร็จครบทุกคนแล้ว");
});
