// ===== FIREBASE CONFIGURATION — CLEAN SLATE =====

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAvv67WmimCBYS8tda6p_NTWUq8x6M_Y-w",
  authDomain: "emergencias-b16bd.web.app", // Match hosting for better PWA redirect stability
  projectId: "emergencias-b16bd",
  storageBucket: "emergencias-b16bd.appspot.com",
  messagingSenderId: "367150772719",
  appId: "1:367150772719:web:5d2219467645856488775f"
};

// Backend URL on Render
const BACKEND_URL = "https://alerta-emergencias.onrender.com";

// --- Session Utility ---
function saveSession(data) { localStorage.setItem('user_session', JSON.stringify(data)); }
function getSession() { try { return JSON.parse(localStorage.getItem('user_session')); } catch { return null; } }
function clearSession() { localStorage.removeItem('user_session'); }

function isAdminEmail(email) {
  return email === "leandroescorza789@gmail.com";
}

// --- Fetch Helpers (Backend Sync) ---
async function fsRequest(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(`${BACKEND_URL}/api/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Error desconocido' }));
    throw new Error(err.error || 'Fallo en la comunicación con el servidor.');
  }
  return res.json();
}

// Standard helper aliases
const fsGet = (path, t) => fsRequest('GET', path, null, t);
const fsPatch = (path, body, t) => fsRequest('PATCH', path, body, t);
const fsPost = (path, body, t) => fsRequest('POST', path, body, t);

// Compatibility stubs for code that expects Firebase object syntax
const fsString = (v) => v;
const fsTimestamp = () => new Date().toISOString();

// Auth service wrappers
async function authSignIn(email, password) {
  return firebase.auth().signInWithEmailAndPassword(email, password)
    .then(async (res) => {
      const tok = await res.user.getIdToken();
      return { 
        idToken: tok, 
        email: res.user.email, 
        localId: res.user.uid, 
        refreshToken: res.user.refreshToken,
        expiresIn: "3600" 
      };
    });
}

async function authSignUp(email, password) {
  return firebase.auth().createUserWithEmailAndPassword(email, password)
    .then(async (res) => {
      const tok = await res.user.getIdToken();
      return { 
        idToken: tok, 
        email: res.user.email, 
        localId: res.user.uid, 
        refreshToken: res.user.refreshToken,
        expiresIn: "3600" 
      };
    });
}
