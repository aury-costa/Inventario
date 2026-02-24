import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getDatabase, ref, update, onValue, serverTimestamp, push, set } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCBEsDwsK6ti_h-cEUSB8KU3-mRn1dyyfs",
  authDomain: "inventario-9ef96.firebaseapp.com",
  databaseURL: "https://inventario-9ef96-default-rtdb.firebaseio.com/",
  projectId: "inventario-9ef96",
  storageBucket: "inventario-9ef96.firebasestorage.app",
  messagingSenderId: "485612248460",
  appId: "1:485612248460:web:13bb81d2da5dffdf1b0aa9",
  measurementId: "G-Z6LKGWESZC"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let currentUser = null;
let sessionId = null;

function safeKey(s){
  return String(s || "").replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 80) || "anon";
}
function todayId(){
  const d=new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
}
function makeSessionId(meta){
  const base=todayId();
  const unit=safeKey(meta?.unidade||"");
  return unit ? `${base}_${unit}` : base;
}

function fbSetUser(username){ currentUser = safeKey(username); return currentUser; }
function fbInit(meta){
  sessionId = makeSessionId(meta||{});
  const metaRef = ref(db, `inventarios/${sessionId}/meta`);
  return update(metaRef, { ...meta, updatedAt: serverTimestamp() });
}
function fbSaveCount(productKey, payload){
  if(!currentUser) currentUser="anon";
  const k = safeKey(productKey);
  const r = ref(db, `inventarios/${sessionId}/counts/${k}`);
  return update(r, { ...payload, user: currentUser, ts: serverTimestamp() });
}
function fbListenCounts(cb){
  const r = ref(db, `inventarios/${sessionId}/counts`);
  return onValue(r, (snap)=> cb(snap.val() || {}));
}
function fbLogEvent(type, data){
  const r = ref(db, `inventarios/${sessionId}/events`);
  const p = push(r);
  return set(p, { type, data: data||{}, user: currentUser||"anon", ts: serverTimestamp() });
}

window.FB = { fbSetUser, fbInit, fbSaveCount, fbListenCounts, fbLogEvent };
