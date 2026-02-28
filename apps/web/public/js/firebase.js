import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAzRiHElsEa_PFOf90mJXzVELsuHwG5_fM",
  authDomain: "medeasehosting.firebaseapp.com",
  projectId: "medeasehosting",
  storageBucket: "medeasehosting.firebasestorage.app",
  messagingSenderId: "527953102643",
  appId: "1:527953102643:web:bce13ed6305ef583016046"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
