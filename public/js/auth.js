// ===== AUTH.JS — Login & Register Logic =====
// Handles authentication, role detection, and page routing

(function () {
  'use strict';

  // Initialize Firebase app globally for auth
  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }

  // ---- Check if already logged in ----
  const session = getSession();
  if (session && session.idToken) {
    redirectByRole(session.email);
    return;
  }

  // ---- Handle Google Redirect Login for PWA ----
  firebase.auth().getRedirectResult().then(async (result) => {
    if (result && result.user) {
      setLoading('login', true);
      const user = result.user;
      const sData = {
        uid: user.uid,
        email: user.email,
        idToken: await user.getIdToken(),
        refreshToken: user.refreshToken,
        expiresAt: Date.now() + 3600000
      };
      
      saveSession(sData);

      try {
        const tok = sData.idToken;
        await fsGet(`users/${user.uid}`, tok).catch(async () => {
          await fsPatch(`users/${user.uid}`, {
            uid:              fsString(user.uid),
            email:            fsString(user.email),
            name:             fsString(user.displayName),
            phone:            fsString(''),
            emergencyContact: fsString(''),
            role:             fsString('user'),
            createdAt:        fsTimestamp()
          }, tok);
        });
      } catch (fErr) {
        console.warn('Profile sync failed:', fErr.message);
      }

      redirectByRole(user.email);
    }
  }).catch(err => {
    showError('login', err.message);
  });

  // ---- Tab switching ----
  window.showTab = function (tab) {
    document.getElementById('tab-login').classList.toggle('active', tab === 'login');
    document.getElementById('tab-register').classList.toggle('active', tab === 'register');
    document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
    document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
  };

  function showError(formId, msg) {
    const el = document.getElementById(formId + '-error');
    if (el) { el.textContent = translateError(msg); el.classList.remove('hidden'); }
  }
  function hideError(formId) {
    const el = document.getElementById(formId + '-error');
    if (el) el.classList.add('hidden');
  }

  function translateError(msg) {
    const map = {
      'EMAIL_NOT_FOUND': 'No existe una cuenta con ese correo.',
      'INVALID_PASSWORD': 'Contraseña incorrecta.',
      'INVALID_LOGIN_CREDENTIALS': 'Correo o contraseña incorrectos.',
      'USER_DISABLED': 'Esta cuenta ha sido deshabilitada.',
      'EMAIL_EXISTS': 'Ya existe una cuenta con ese correo.',
      'WEAK_PASSWORD : Password should be at least 6 characters': 'La contraseña debe tener al menos 6 caracteres.',
      'TOO_MANY_ATTEMPTS_TRY_LATER': 'Demasiados intentos. Intenta más tarde.',
    };
    for (const [k, v] of Object.entries(map)) {
      if (msg && msg.includes(k)) return v;
    }
    return msg || 'Ocurrió un error. Intenta de nuevo.';
  }

  function setLoading(formId, loading) {
    const btn = document.getElementById(formId + '-btn');
    if (!btn) return;
    if (formId === 'login') {
      document.getElementById('login-btn-text').textContent = loading ? 'Ingresando...' : 'Ingresar';
    } else {
      document.getElementById('register-btn-text').textContent = loading ? 'Creando cuenta...' : 'Crear cuenta';
    }
    btn.disabled = loading;
  }

  function redirectByRole(email) {
    if (isAdminEmail(email)) {
      window.location.href = 'admin.html';
    } else {
      window.location.href = 'user.html';
    }
  }

  // ---- LOGIN ----
  window.handleLogin = async function (e) {
    e.preventDefault();
    hideError('login');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    setLoading('login', true);
    try {
      const data = await authSignIn(email, password);
      saveSession({
        uid: data.localId,
        email: data.email,
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + (parseInt(data.expiresIn) * 1000)
      });
      redirectByRole(data.email);
    } catch (err) {
      showError('login', err.message);
      setLoading('login', false);
    }
  };

  // ---- REGISTER ----
  window.handleRegister = async function (e) {
    e.preventDefault();
    hideError('register');

    const name = document.getElementById('reg-name').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const contact = document.getElementById('reg-contact').value.trim();
    const email = document.getElementById('reg-email').value.trim().toLowerCase();
    const password = document.getElementById('reg-password').value;

    // Block admin email from being registered through the form
    if (isAdminEmail(email)) {
      showError('register', 'Este correo es de uso exclusivo del administrador del sistema.');
      return;
    }

    setLoading('register', true);
    try {
      const data = await authSignUp(email, password);
      const session = {
        uid: data.localId,
        email: data.email,
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + (parseInt(data.expiresIn) * 1000)
      };
      saveSession(session);

      // Save user profile to Firestore
      try {
        await fsPatch(`users/${data.localId}`, {
          uid:              fsString(data.localId),
          email:            fsString(email),
          name:             fsString(name),
          phone:            fsString(phone),
          emergencyContact: fsString(contact),
          role:             fsString('user'),
          createdAt:        fsTimestamp()
        }, data.idToken);
      } catch (firestoreErr) {
        console.warn('Could not save profile to Firestore:', firestoreErr.message);
        // Continue anyway — user is created
      }

      redirectByRole(data.email);
    } catch (err) {
      showError('register', err.message);
      setLoading('register', false);
    }
  };

  // ---- GOOGLE LOGIN ----
  window.handleGoogleLogin = function () {
    hideError('login');
    const btn = document.getElementById('google-btn');
    btn.disabled = true;
    
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      // Usar Redirect en vez de Popup para evitar problemas en PWA/móviles
      firebase.auth().signInWithRedirect(provider);
    } catch (err) {
      showError('login', err.message);
      btn.disabled = false;
    }
  };

  // ---- LOGOUT ----
  window.handleLogout = function () {
    clearSession();
    window.location.href = 'index.html';
  };

})();
