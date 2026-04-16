// ===== AUTH.JS — REBUILT FROM SCRATCH =====

(function() {
  'use strict';

  // 1. Initialize Firebase
  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }

  // 2. Global Auth State Listener
  firebase.auth().onAuthStateChanged(async (user) => {
    console.log('[Auth] Estado cambiado. Usuario:', user ? user.email : 'Ninguno');
    
    if (user) {
      // Get fresh token
      const idToken = await user.getIdToken(true);
      
      // Save session for the rest of the app
      const sessionData = {
        uid: user.uid,
        email: user.email,
        idToken: idToken,
        refreshToken: user.refreshToken,
        expiresAt: Date.now() + 3600000
      };
      saveSession(sessionData);

      // Silent sync with Render backend
      try {
        console.log('[Auth] Verificando perfil en servidor...');
        await fsGet(`users/${user.uid}`, idToken).catch(async (err) => {
          console.log('[Auth] Perfil no encontrado, creando uno nuevo...');
          await fsPatch(`users/${user.uid}`, {
            uid: user.uid,
            email: user.email,
            name: user.displayName || 'Usuario Google',
            phone: '',
            emergencyContact: '',
            role: 'user',
            createdAt: new Date().toISOString()
          }, idToken);
        });
      } catch (e) {
        console.warn('[Auth] Error de sincronización (no crítico):', e.message);
      }

      // Redirect if we are on login page
      if (window.location.pathname.endsWith('index.html') || window.location.pathname === '/') {
        console.log('[Auth] Redirigiendo por rol...');
        redirectByRole(user.email);
      }
    } else {
      console.log('[Auth] Sin sesión activa - listo para login.');
    }
  });

  // 3. Handle Google Redirect Result
  // This captures any errors if the redirect flow fails
  firebase.auth().getRedirectResult().then(result => {
    if (result && result.user) {
      console.log('[Auth] Éxito post-redirección:', result.user.email);
    }
  }).catch(err => {
    console.error('[Auth] Error en resultado de Google:', err.code, err.message);
    showError('login', 'Error de Google: ' + err.message);
  });

  // --- UI Logic ---
  window.showTab = (tab) => {
    document.getElementById('tab-login').classList.toggle('active', tab === 'login');
    document.getElementById('tab-register').classList.toggle('active', tab === 'register');
    document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
    document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
  };

  const showError = (formId, msg) => {
    const el = document.getElementById(formId + '-error');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  };
  const hideError = (formId) => {
    const el = document.getElementById(formId + '-error');
    if (el) el.classList.add('hidden');
  };

  const setLoading = (formId, isLoading) => {
    const btn = document.getElementById(formId + '-btn');
    const text = document.getElementById(formId + '-btn-text');
    if (!btn || !text) return;
    btn.disabled = isLoading;
    text.textContent = isLoading ? (formId === 'login' ? 'Ingresando...' : 'Creando...') : (formId === 'login' ? 'Ingresar' : 'Crear cuenta');
  };

  const redirectByRole = (email) => {
    window.location.href = isAdminEmail(email) ? 'admin.html' : 'user.html';
  };

  // --- Handlers ---

  // Manual Login (Email/Password)
  window.handleLogin = async (e) => {
    e.preventDefault();
    hideError('login');
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-password').value;
    
    setLoading('login', true);
    try {
      await authSignIn(email, pass);
      // onAuthStateChanged will handle the rest
    } catch (err) {
      showError('login', 'Error: Correo o contraseña incorrectos.');
      setLoading('login', false);
    }
  };

  // Manual Register (Email/Password)
  window.handleRegister = async (e) => {
    e.preventDefault();
    hideError('register');
    
    const email = document.getElementById('reg-email').value.trim();
    const pass = document.getElementById('reg-password').value;
    const name = document.getElementById('reg-name').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const contact = document.getElementById('reg-contact').value.trim();

    if (isAdminEmail(email)) {
      showError('register', 'Este correo es reservado.');
      return;
    }

    setLoading('register', true);
    try {
      const data = await authSignUp(email, pass);
      // Wait a moment for Firebase to register, then sync profile
      await fsPatch(`users/${data.localId}`, {
        uid: data.localId,
        email: email,
        name: name,
        phone: phone,
        emergencyContact: contact,
        role: 'user',
        createdAt: new Date().toISOString()
      }, data.idToken);
      // onAuthStateChanged handles redirect
    } catch (err) {
      showError('register', err.message);
      setLoading('register', false);
    }
  };

  // Google Login (Redirect)
  window.handleGoogleLogin = () => {
    console.log('[Auth] Iniciando flujo Google Redirect...');
    const provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithRedirect(provider);
  };

  // Logout
  window.handleLogout = () => {
    firebase.auth().signOut().then(() => {
      clearSession();
      window.location.href = 'index.html';
    });
  };

})();
