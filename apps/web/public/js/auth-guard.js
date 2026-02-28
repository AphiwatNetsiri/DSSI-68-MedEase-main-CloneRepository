import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAzRiHElsEa_PFOf90mJXzVELsuHwG5_fM",
  authDomain: "medeasehosting.firebaseapp.com",
  projectId: "medeasehosting",
};
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    const next = encodeURIComponent(location.pathname);
    location.href = `../login.html?next=${next}`;
    return;
  }
  const tokenResult = await user.getIdTokenResult(true);
  if (tokenResult.claims?.admin !== true) {
    alert("บัญชีนี้ไม่ใช่แอดมิน");
    await signOut(auth);
    location.href = "../login.html";
  }
});

// เผื่อปุ่ม logout ทั่วไป
window.__adminLogout = async () => {
  await signOut(auth);
  location.href = "../login.html";
};
