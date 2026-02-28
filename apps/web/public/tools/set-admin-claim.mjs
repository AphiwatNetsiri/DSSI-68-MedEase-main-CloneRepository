// tools/set-admin-claim.mjs
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMAIL = process.argv[2] || "someone@your-domain.tld";

// เลือกแหล่ง credential: 1) GOOGLE_APPLICATION_CREDENTIALS 2) ./serviceAccountKey.json 3) ADC
function initAdmin() {
  const envKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const localKeyPath = path.join(__dirname, "..", "serviceAccountKey.json");

  let credential;
  if (envKeyPath && fs.existsSync(envKeyPath)) {
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(envKeyPath, "utf8")));
  } else if (fs.existsSync(localKeyPath)) {
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(localKeyPath, "utf8")));
  } else {
    // จะใช้ Application Default Credentials แทน (ต้องมีการตั้งค่าในระบบไว้แล้ว)
    credential = admin.credential.applicationDefault();
  }

  admin.initializeApp({ credential });
}

async function main() {
  initAdmin();
  const user = await admin.auth().getUserByEmail(EMAIL);
  await admin.auth().setCustomUserClaims(user.uid, { admin: true });
  console.log("✅ set admin=true for", EMAIL);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
