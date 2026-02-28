// ================== /public/js/messages.js ==================
// ใช้ Firebase v10 (modular)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  getIdTokenResult,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ===== Firebase config =====
const firebaseConfig = {
  apiKey: "AIzaSyAzRiHElsEa_PFOf90mJXzVELsuHwG5_fM",
  authDomain: "medeasehosting.firebaseapp.com",
  projectId: "medeasehosting",
  storageBucket: "medeasehosting.firebasestorage.app",
  messagingSenderId: "527953102643",
  appId: "1:527953102643:web:bce13ed6305ef583016046",
};

// ===== Init Firebase =====
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ===== Helpers =====
function normalizeTimestamp(...values) {
  for (const v of values) {
    if (!v) continue;
    if (typeof v.toDate === "function") return v.toDate(); // Firestore Timestamp
    if (typeof v === "number") return new Date(v); // epoch ms
    if (v instanceof Date) return v;
  }
  return null;
}

function formatDateTime(d) {
  if (!d || isNaN(d.getTime())) return "-";
  return d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}

function formatDate(d) {
  if (!d || isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("th-TH", { dateStyle: "short" });
}

function getUrlParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// หน้า user-conversations.html
// ============================================================
async function loadUserConversationsPage(user, context) {
  const emailEl = document.getElementById("ucCurrentUserEmail");
  const roleBadgeEl = document.getElementById("ucRoleBadge");
  const targetNameEl = document.getElementById("ucTargetUserName");
  const targetMetaEl = document.getElementById("ucTargetUserMeta");
  const statusTextEl = document.getElementById("ucStatusText");

  const loadingEl = document.getElementById("ucLoadingState");
  const emptyEl = document.getElementById("ucEmptyState");
  const listEl = document.getElementById("ucConversationsList");
  const countEl = document.getElementById("ucConversationsCount");

  const searchInput = document.getElementById("ucSearchInput");
  const createdFromInput = document.getElementById("ucCreatedFrom");
  const createdToInput = document.getElementById("ucCreatedTo");

  // ข้อมูล target จาก URL (โหมด admin ดูของคนอื่น)
  const targetUidParam = getUrlParam("uid");
  const targetDisplayNameParam = getUrlParam("displayName") || "";
  const targetEmailParam = getUrlParam("email") || "";
  const targetLineUserIdParam = getUrlParam("lineUserId") || "";

  let targetUid = user.uid;
  let viewMode = "self";

  if (targetUidParam && targetUidParam !== user.uid) {
    if (!context.isAdminOrStaff) {
      showUserConversationsNoPermission();
      return;
    }
    targetUid = targetUidParam;
    viewMode = "admin-other";
  }

  // แสดงข้อมูลผู้ใช้ปัจจุบันด้านบน
  if (emailEl) emailEl.textContent = user.email || "";
  if (context.isAdminOrStaff && roleBadgeEl) {
    roleBadgeEl.classList.remove("hidden");
  }

  if (viewMode === "self") {
    if (targetNameEl) targetNameEl.textContent = user.displayName || "คุณ";
    if (targetMetaEl) {
      targetMetaEl.textContent = user.email ? `อีเมล: ${user.email}` : "";
    }
  } else {
    if (targetNameEl)
      targetNameEl.textContent = targetDisplayNameParam || `UID: ${targetUid}`;
    if (targetMetaEl) {
      const parts = [];
      if (targetEmailParam) parts.push(`อีเมล: ${targetEmailParam}`);
      if (targetLineUserIdParam) parts.push(`LINE: ${targetLineUserIdParam}`);
      targetMetaEl.textContent = parts.join(" • ");
    }
  }

  if (statusTextEl) statusTextEl.textContent = "";

  if (loadingEl) loadingEl.classList.remove("hidden");
  if (emptyEl) emptyEl.classList.add("hidden");
  if (listEl) listEl.innerHTML = "";
  if (countEl) countEl.textContent = "";

  // Query หลัก
  let qConv;

  if (context.isAdminOrStaff) {
    if (!targetUidParam) {
      // แอดมิน: ดูทุกห้อง
      qConv = query(
        collection(db, "conversations"),
        orderBy("lastMessageAt", "desc"),
        limit(200)
      );
    } else {
      // แอดมิน: ดูของ uid เป้าหมาย
      qConv = query(
        collection(db, "conversations"),
        where("ownerUid", "==", targetUid),
        orderBy("lastMessageAt", "desc"),
        limit(200)
      );
    }
  } else {
    // user ธรรมดา: ดูเฉพาะของตัวเอง (ownerUid)
    qConv = query(
      collection(db, "conversations"),
      where("ownerUid", "==", targetUid),
      orderBy("lastMessageAt", "desc"),
      limit(200)
    );
  }

  let snapshot;
  try {
    snapshot = await getDocs(qConv);
  } catch (err) {
    console.error("loadUserConversationsPage error:", err);
    if (loadingEl) {
      loadingEl.textContent =
        "เกิดข้อผิดพลาดในการโหลดบทสนทนา ลองรีเฟรชหน้าอีกครั้ง หรือเช็กใน Firebase console";
    }
    return;
  }

  const items = [];
  snapshot.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const createdAt = normalizeTimestamp(data.createdAt, data.lastMessageAt);
    const lastMessageAt = normalizeTimestamp(
      data.lastMessageAt,
      data.updatedAt,
      data.createdAt
    );
    const title =
      data.title ||
      data.lastMessageText ||
      `บทสนทนา ${String(docSnap.id).slice(0, 6)}…`;

    items.push({
      id: docSnap.id,
      title,
      createdAt,
      lastMessageAt,
      messagesCount:
        data.messagesCount || data.messageCount || data.totalMessages || 0,
    });
  });

  if (loadingEl) loadingEl.classList.add("hidden");

  if (!items.length) {
    if (emptyEl) emptyEl.classList.remove("hidden");
    if (statusTextEl) {
      statusTextEl.textContent =
        "ยังไม่มีบทสนทนาสำหรับผู้ใช้นี้ การแชทครั้งแรกจะถูกบันทึกโดยอัตโนมัติ";
    }
    if (countEl) countEl.textContent = "0 บทสนทนา";
    return;
  }

  if (emptyEl) emptyEl.classList.add("hidden");
  if (countEl) countEl.textContent = `${items.length} บทสนทนา`;

  // ----- ฟิลเตอร์ฝั่ง client -----
  function applyFiltersAndRender() {
    const search = (searchInput?.value || "").trim().toLowerCase();
    const fromStr = createdFromInput?.value || "";
    const toStr = createdToInput?.value || "";

    let fromDate = null;
    let toDate = null;
    if (fromStr) {
      fromDate = new Date(fromStr + "T00:00:00");
    }
    if (toStr) {
      toDate = new Date(toStr + "T23:59:59");
    }

    const filtered = items.filter((item) => {
      if (fromDate && item.createdAt && item.createdAt < fromDate) return false;
      if (toDate && item.createdAt && item.createdAt > toDate) return false;

      if (search) {
        const haystack = (item.title || "").toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    renderConversationsList(filtered);
  }

  function renderConversationsList(conversations) {
    if (!listEl || !countEl || !emptyEl) return;

    listEl.innerHTML = "";

    if (!conversations.length) {
      emptyEl.classList.remove("hidden");
      countEl.textContent = "0 บทสนทนา";
      return;
    }

    emptyEl.classList.add("hidden");
    countEl.textContent = `${conversations.length} บทสนทนา`;

    conversations.forEach((conv) => {
      const li = document.createElement("li");
      li.className =
        "px-4 py-3 flex items-center justify-between gap-3 hover:bg-slate-50";

      const left = document.createElement("div");
      left.className = "flex-1 min-w-0";
      left.innerHTML = `
        <p class="text-sm font-medium text-slate-900 truncate">
          ${escapeHtml(conv.title)}
        </p>
        <p class="text-xs text-slate-500 mt-0.5">
          สร้างเมื่อ: ${formatDateTime(conv.createdAt)} · 
          อัปเดตล่าสุด: ${formatDateTime(conv.lastMessageAt)}
        </p>
      `;

      const right = document.createElement("div");
      right.className = "flex items-center gap-2";

      const openLink = document.createElement("a");
      openLink.href = `/conversation.html?id=${encodeURIComponent(conv.id)}`;
      openLink.className =
        "inline-flex items-center rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600";
      openLink.textContent = "เปิด";

      right.appendChild(openLink);

      li.appendChild(left);
      li.appendChild(right);
      listEl.appendChild(li);
    });
  }

  // ผูก event ฟิลเตอร์
  if (searchInput) {
    searchInput.addEventListener("input", applyFiltersAndRender);
  }
  if (createdFromInput) {
    createdFromInput.addEventListener("change", applyFiltersAndRender);
  }
  if (createdToInput) {
    createdToInput.addEventListener("change", applyFiltersAndRender);
  }

  // render รอบแรก
  applyFiltersAndRender();
}

// ===== กรณีไม่ได้ล็อกอิน =====
function showUserConversationsSignedOut() {
  const emailEl = document.getElementById("ucCurrentUserEmail");
  const targetNameEl = document.getElementById("ucTargetUserName");
  const targetMetaEl = document.getElementById("ucTargetUserMeta");
  const statusTextEl = document.getElementById("ucStatusText");
  const loadingEl = document.getElementById("ucLoadingState");
  const emptyEl = document.getElementById("ucEmptyState");

  if (emailEl) emailEl.textContent = "";
  if (targetNameEl) targetNameEl.textContent = "-";
  if (targetMetaEl) targetMetaEl.textContent = "";
  if (statusTextEl)
    statusTextEl.textContent = "กรุณาเข้าสู่ระบบก่อนใช้งานหน้านี้";

  if (loadingEl) loadingEl.classList.add("hidden");
  if (emptyEl) emptyEl.classList.remove("hidden");
}

function showUserConversationsNoPermission() {
  const main = document.querySelector("main");
  if (main) {
    main.innerHTML =
      '<div class="max-w-xl mx-auto px-4 py-10 text-center text-sm text-red-600">คุณไม่มีสิทธิ์เข้าถึงประวัติการสนทนาของผู้ใช้อื่น หากคิดว่าเป็นข้อผิดพลาด โปรดติดต่อผู้ดูแลระบบ</div>';
  }
}

// ============================================================
// หน้า conversation.html (แสดงข้อความทั้งห้อง + filter + export)
// ============================================================
async function loadConversationDetailPage(user, context) {
  const convId = getUrlParam("id");

  const titleEl = document.getElementById("convTitle");
  const metaEl = document.getElementById("convMeta");
  const countBadgeEl = document.getElementById("convCountBadge");

  const loadingEl = document.getElementById("convLoading");
  const emptyEl = document.getElementById("convEmpty");
  const scrollWrapEl = document.getElementById("convMessagesScroll");
  const listEl = document.getElementById("convMessages");

  const filterButtons = document.querySelectorAll("[data-filter-btn]");
  const scrollBottomBtn = document.getElementById("convScrollBottomBtn");
  const exportJsonBtn = document.getElementById("convExportJsonBtn");
  const exportCsvBtn = document.getElementById("convExportCsvBtn");

  if (!convId) {
    if (metaEl) metaEl.textContent = "ไม่พบรหัสบทสนทนาใน URL";
    return;
  }

  if (loadingEl) {
    loadingEl.classList.remove("hidden");
    loadingEl.textContent = "กำลังโหลดบทสนทนา...";
  }
  if (emptyEl) emptyEl.classList.add("hidden");
  if (scrollWrapEl) scrollWrapEl.classList.add("hidden");
  if (listEl) listEl.innerHTML = "";
  if (countBadgeEl) countBadgeEl.textContent = "0 ข้อความ";

  // ----- โหลดข้อมูลห้องสนทนา -----
  let convData = null;
  try {
    const convRef = doc(db, "conversations", convId);
    const snap = await getDoc(convRef);
    if (!snap.exists()) {
      if (loadingEl) loadingEl.classList.add("hidden");
      if (emptyEl) {
        emptyEl.classList.remove("hidden");
        emptyEl.textContent = "ไม่พบบทสนทนานี้ในระบบ";
      }
      if (titleEl) titleEl.textContent = "ไม่พบบทสนทนา";
      return;
    }
    convData = snap.data() || {};
    console.log("[CONV] detail doc =", convId, convData);
  } catch (err) {
    console.error("[CONV] load conv error:", err);
    if (loadingEl) loadingEl.textContent = "โหลดข้อมูลห้องสนทนาไม่สำเร็จ";
    return;
  }

  const createdAt = normalizeTimestamp(convData.createdAt);
  const updatedAt = normalizeTimestamp(
    convData.lastMessageAt,
    convData.updatedAt
  );

  const titleText =
    convData.title ||
    convData.lastMessageText ||
    `บทสนทนา: ${String(convId).slice(0, 8)}…`;

  if (titleEl) titleEl.textContent = titleText;
  if (metaEl) {
    const parts = [];
    if (convData.userId) parts.push(`LINE userId: ${convData.userId}`);
    if (createdAt) parts.push(`สร้างเมื่อ: ${formatDateTime(createdAt)}`);
    if (updatedAt) parts.push(`อัปเดตล่าสุด: ${formatDateTime(updatedAt)}`);
    metaEl.textContent = parts.join(" · ");
  }

  // ----- โหลด intent_logs ของ user นี้ (ถ้ามี) -----
  const intentsByText = new Map();
  try {
    if (convData.userId) {
      const qIntent = query(
        collection(db, "intent_logs"),
        where("userId", "==", convData.userId),
        orderBy("createdAt", "asc"),
        limit(500)
      );
      const intentSnap = await getDocs(qIntent);
      intentSnap.forEach((docSnap) => {
        const d = docSnap.data() || {};
        const text = (d.text || "").trim();
        if (!text) return;
        intentsByText.set(text, { id: docSnap.id, ...d });
      });
    }
  } catch (err) {
    console.warn("[CONV] load intent_logs error:", err);
  }

  // ----- โหลด messages ในห้องนี้ -----
  let allMessages = [];
  try {
    const qMsgs = query(
      collection(db, "messages"),
      where("conversationId", "==", convId),
      orderBy("createdAt", "asc"),
      limit(1000)
    );
    const msgSnap = await getDocs(qMsgs);

    msgSnap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const created = normalizeTimestamp(data.createdAt);

      const senderRaw =
        data.sender || data.meta?.sender || data.meta?.role || "user";
      const sender =
        senderRaw === "bot" || data.meta?.toolUsed === "chatgpt"
          ? "bot"
          : "user";

      const text = (data.meta?.text || data.text || "").trim();
      const toolUsed = data.meta?.toolUsed || (sender === "bot" ? "chatgpt" : "line");

      const intentMatch = intentsByText.get(text) || null;
      const intentLabel =
        intentMatch?.finalAction ||
        intentMatch?.intent ||
        intentMatch?.predicted ||
        null;
      const intentConfidence =
        typeof intentMatch?.confidence === "number"
          ? intentMatch.confidence
          : null;

      allMessages.push({
        id: docSnap.id,
        createdAt: created,
        sender,
        toolUsed,
        text,
        intentLabel,
        intentConfidence,
      });
    });

    console.log("[CONV] messages size =", allMessages.length);
  } catch (err) {
    console.error("[CONV] load messages error:", err);
    if (loadingEl) loadingEl.textContent = "โหลดข้อความไม่สำเร็จ";
    return;
  }

  if (loadingEl) loadingEl.classList.add("hidden");

  if (!allMessages.length) {
    if (emptyEl) {
      emptyEl.classList.remove("hidden");
      emptyEl.textContent = "ยังไม่มีข้อความในบทสนทนานี้";
    }
    if (countBadgeEl) countBadgeEl.textContent = "0 ข้อความ";
    return;
  }

  if (scrollWrapEl) scrollWrapEl.classList.remove("hidden");
  if (emptyEl) emptyEl.classList.add("hidden");

  let currentFilter = "all";

  function getFilteredMessages() {
    if (currentFilter === "all") return allMessages;
    return allMessages.filter((m) => m.sender === currentFilter);
  }

  function renderMessages() {
    if (!listEl) return;
    const filtered = getFilteredMessages();

    listEl.innerHTML = "";

    if (!filtered.length) {
      if (emptyEl) {
        emptyEl.classList.remove("hidden");
        emptyEl.textContent =
          currentFilter === "user"
            ? "ยังไม่มีข้อความจากผู้ใช้ในบทสนทนานี้"
            : "ยังไม่มีข้อความจาก Arisa ในบทสนทนานี้";
      }
      if (countBadgeEl) countBadgeEl.textContent = "0 ข้อความ";
      return;
    }

    if (emptyEl) emptyEl.classList.add("hidden");
    if (countBadgeEl)
      countBadgeEl.textContent = `${filtered.length} ข้อความ`;

    filtered.forEach((msg) => {
      const alignRight = msg.sender === "user";

      const row = document.createElement("div");
      row.className = `flex ${
        alignRight ? "justify-end" : "justify-start"
      } px-2`;

      const block = document.createElement("div");
      block.className = "max-w-[80%]";

      const bubble = document.createElement("div");
      bubble.className =
        "rounded-2xl px-4 py-2.5 text-sm shadow-sm break-words whitespace-pre-line";
      if (alignRight) {
        bubble.className +=
          " bg-sky-500 text-white rounded-br-md ml-auto";
      } else {
        bubble.className +=
          " bg-white text-slate-900 border border-slate-200 rounded-bl-md";
      }

      const textP = document.createElement("p");
      textP.textContent = msg.text || "";
      bubble.appendChild(textP);

      const metaRow = document.createElement("div");
      metaRow.className =
        "mt-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500";

      const timeSpan = document.createElement("span");
      timeSpan.textContent = formatDateTime(msg.createdAt);
      metaRow.appendChild(timeSpan);

      const rightMeta = document.createElement("div");
      rightMeta.className = "flex flex-wrap items-center gap-1";

      const senderBadge = document.createElement("span");
      senderBadge.className =
        "inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5";
      senderBadge.textContent =
        msg.sender === "user" ? "ผู้ใช้ · LINE" : "Arisa · ChatGPT";
      rightMeta.appendChild(senderBadge);

      if (msg.intentLabel) {
        const intentBadge = document.createElement("span");
        intentBadge.className =
          "inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700";
        intentBadge.textContent = msg.intentConfidence
          ? `intent: ${msg.intentLabel} (${Math.round(
              msg.intentConfidence * 100
            )}%)`
          : `intent: ${msg.intentLabel}`;
        rightMeta.appendChild(intentBadge);
      }

      metaRow.appendChild(rightMeta);

      block.appendChild(bubble);
      block.appendChild(metaRow);
      row.appendChild(block);
      listEl.appendChild(row);
    });

    scrollToBottom();
  }

  function scrollToBottom() {
    if (!scrollWrapEl) return;
    scrollWrapEl.scrollTop = scrollWrapEl.scrollHeight;
  }

  // ----- ปุ่ม filter -----
  if (filterButtons && filterButtons.length) {
    filterButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const filter = btn.getAttribute("data-filter") || "all";
        currentFilter = filter;

        // toggle style
        filterButtons.forEach((b) => {
          b.classList.remove("bg-white", "shadow-sm", "font-medium");
          b.classList.add("text-slate-600");
        });
        btn.classList.add("bg-white", "shadow-sm", "font-medium");
        btn.classList.remove("text-slate-600");

        renderMessages();
      });
    });
  }

  // ----- ปุ่ม scroll bottom -----
  if (scrollBottomBtn) {
    scrollBottomBtn.addEventListener("click", () => {
      scrollToBottom();
    });
  }

  // ----- Export helpers -----
  function downloadBlob(filename, mimeType, text) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    const payload = {
      conversationId: convId,
      conversationMeta: {
        userId: convData.userId || null,
        createdAt: createdAt ? createdAt.toISOString() : null,
        updatedAt: updatedAt ? updatedAt.toISOString() : null,
        status: convData.status || null,
        title: titleText,
      },
      messages: allMessages.map((m) => ({
        id: m.id,
        sender: m.sender,
        toolUsed: m.toolUsed,
        text: m.text,
        createdAt: m.createdAt ? m.createdAt.toISOString() : null,
        intentLabel: m.intentLabel || null,
        intentConfidence: m.intentConfidence ?? null,
      })),
    };

    downloadBlob(
      `conversation-${convId}.json`,
      "application/json;charset=utf-8",
      JSON.stringify(payload, null, 2)
    );
  }

  function toCsvValue(v) {
    if (v == null) return '""';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  }

  function exportCsv() {
    const header = [
      "id",
      "sender",
      "toolUsed",
      "createdAt",
      "text",
      "intentLabel",
      "intentConfidence",
    ];

    const rows = [header.join(",")];

    allMessages.forEach((m) => {
      rows.push(
        [
          m.id,
          m.sender,
          m.toolUsed,
          m.createdAt ? m.createdAt.toISOString() : "",
          m.text,
          m.intentLabel || "",
          m.intentConfidence ?? "",
        ]
          .map(toCsvValue)
          .join(",")
      );
    });

    downloadBlob(
      `conversation-${convId}.csv`,
      "text/csv;charset=utf-8",
      rows.join("\r\n")
    );
  }

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener("click", exportJson);
  }
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener("click", exportCsv);
  }

  // render ครั้งแรก + auto scroll ล่างสุด
  renderMessages();
}

// ============================================================
// Entry point ตาม data-page
// ============================================================
onAuthStateChanged(auth, async (user) => {
  const page = document.body.dataset.page || "";

  if (page === "user-conversations") {
    if (!user) {
      showUserConversationsSignedOut();
      return;
    }

    try {
      const tokenResult = await getIdTokenResult(user);
      const claims = tokenResult.claims || {};
      const isAdminOrStaff =
        claims.admin === true ||
        claims.staff === true ||
        claims.role === "admin" ||
        claims.role === "staff";

      await loadUserConversationsPage(user, { isAdminOrStaff });
    } catch (err) {
      console.error("auth token error:", err);
      await loadUserConversationsPage(user, { isAdminOrStaff: false });
    }
  }

  if (page === "conversation") {
    if (!user) {
      // ให้แสดงข้อความ generic ถ้ายังไม่ล็อกอิน
      const main = document.querySelector("main");
      if (main) {
        main.innerHTML =
          '<div class="max-w-xl mx-auto px-4 py-10 text-center text-sm text-red-600">กรุณาเข้าสู่ระบบก่อนใช้งานหน้านี้</div>';
      }
      return;
    }

    try {
      const tokenResult = await getIdTokenResult(user);
      const claims = tokenResult.claims || {};
      const isAdminOrStaff =
        claims.admin === true ||
        claims.staff === true ||
        claims.role === "admin" ||
        claims.role === "staff";

      // ตอนนี้ยังไม่จำกัดสิทธิ์เฉพาะ admin/staff แต่ถ้าจะจำกัดก็เช็ค isAdminOrStaff ได้
      await loadConversationDetailPage(user, { isAdminOrStaff });
    } catch (err) {
      console.error("auth token error:", err);
      await loadConversationDetailPage(user, { isAdminOrStaff: false });
    }
  }
});

// ================== /public/js/messages.js ==================
