// admin-appointments.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getFirestore, collection, getDocs, orderBy, query } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAzRiHElsEa_PFOf90mJXzVELsuHwG5_fM",
  authDomain: "medeasehosting.firebaseapp.com",
  projectId: "medeasehosting",
  storageBucket: "medeasehosting.appspot.com",
  messagingSenderId: "527953102643",
  appId: "1:527953102643:web:bce13ed6305ef583016046"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function loadAppointments() {
  const tableBody = document.getElementById("appointmentsTable");
  tableBody.innerHTML = "";

  const q = query(collection(db, "appointments"), orderBy("createdAt", "desc"));
  const snapshot = await getDocs(q);

  snapshot.forEach(doc => {
    const data = doc.data();
    const createdAt = data.createdAt?.toDate().toLocaleString("th-TH") || "-";

    const row = `
      <tr>
        <td class="border px-4 py-2">${data.contact}</td>
        <td class="border px-4 py-2">${data.department}</td>
        <td class="border px-4 py-2">${data.date}</td>
        <td class="border px-4 py-2">${data.time}</td>
        <td class="border px-4 py-2">${data.contact.split('/')[1] || '-'}</td>
        <td class="border px-4 py-2">${createdAt}</td>
      </tr>
    `;
    tableBody.innerHTML += row;
  });
}

loadAppointments();
