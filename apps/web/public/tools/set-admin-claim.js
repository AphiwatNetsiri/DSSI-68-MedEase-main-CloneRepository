// tools/set-admin-claim.mjs
import admin from "firebase-admin";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyPath = path.join(__dirname, "../serviceAccountKey.json"); 
const EMAIL = process.argv[2] || "someone@your-domain.tld";

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(keyPath, "utf8"))),
});

const main = async () => {
  const user = await admin.auth().getUserByEmail(EMAIL);
  await admin.auth().setCustomUserClaims(user.uid, { admin: true });
  console.log("✅ set admin=true for", EMAIL);
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
