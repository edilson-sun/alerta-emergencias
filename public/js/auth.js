// ===== AUTH.JS — V3.6 =====

(function() {
  'use strict';
  console.log('[Auth] V3.6 — Google modal + emergency contact split');

  // 1. Initialize Firebase
  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }

  // Variable para guardar datos del usuario Google mientras se completa el perfil
  let pendingGoogleUser = null;

  // 2. Global Auth State Listener
  firebase.auth().onAuthStateChanged(async (user) => {
    if (sessionStorage.getItem('logout_in_progress') === 'true') {
      sessionStorage.removeItem('logout_in_progress');
      return;
    }

    console.log('[Auth] Estado cambiado. Usuario:', user ? user.email : 'Ninguno');
    
    if (user) {
      const idToken = await user.getIdToken(true);
      
      const sessionData = {
        uid: user.uid,
        email: user.email,
        idToken: idToken,
        refreshToken: user.refreshToken,
        expiresAt: Date.now() + 3600000
      };
      saveSession(sessionData);

      // Sync with backend — check for existing profile
      try {
        let profile = null;
        try {
          profile = await fsGet(`users/${user.uid}`, idToken);
        } catch (e) {
          // Profile doesn't exist yet — create it
          profile = null;
        }

        if (!profile || !profile.emergency_contact) {
          // New user or incomplete profile via Google
          // Check if this is after a Google login (not email/password)
          const isGoogleUser = user.providerData.some(p => p.providerId === 'google.com');
          
          if (isGoogleUser && !profile?.emergency_contact) {
            // Pre-create a basic profile so we have something to update
            if (!profile) {
              await fsPatch(`users/${user.uid}`, {
                uid: user.uid,
                email: user.email,
                name: user.displayName || user.email.split('@')[0],
                phone: '',
                emergencyContact: '',
                role: 'user',
              }, idToken);
            }
            pendingGoogleUser = { user, idToken };
            showProfileModal();
            return; // Don't redirect yet
          }
        }
      } catch (e) {
        console.warn('[Auth] Error de sincronización:', e.message);
      }

      // Redirect if on login page
      if (window.location.pathname.endsWith('index.html') || window.location.pathname === '/') {
        redirectByRole(user.email);
      }
    }
  });

  // --- Modal de perfil (para Google) ---
  function showProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.style.display = 'flex';
  }

  function hideProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.style.display = 'none';
  }

  window.handleProfileModal = async function() {
    const phone = (document.getElementById('modal-phone')?.value || '').trim();
    const contactName = (document.getElementById('modal-contact-name')?.value || '').trim();
    const contactPhone = (document.getElementById('modal-contact-phone')?.value || '').trim();
    const errEl = document.getElementById('profile-modal-error');
    const btn = document.getElementById('modal-save-btn');
    const btnText = document.getElementById('modal-save-text');

    if (!phone || !contactName || !contactPhone) {
      if (errEl) { errEl.textContent = 'Por favor completa todos los campos.'; errEl.classList.remove('hidden'); }
      return;
    }
    if (errEl) errEl.classList.add('hidden');
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Guardando...';

    try {
      const { user, idToken } = pendingGoogleUser;
      const emergencyContact = `${contactName} | ${contactPhone}`;

      await fsPatch(`users/${user.uid}`, {
        phone: phone,
        emergencyContact: emergencyContact,
        name: user.displayName || user.email.split('@')[0],
      }, idToken);

      hideProfileModal();
      redirectByRole(user.email);
    } catch (e) {
      if (errEl) { errEl.textContent = 'Error al guardar: ' + e.message; errEl.classList.remove('hidden'); }
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = 'Guardar y continuar →';
    }
  };

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
    text.textContent = isLoading
      ? (formId === 'login' ? 'Ingresando...' : 'Creando cuenta...')
      : (formId === 'login' ? 'Ingresar' : 'Crear cuenta');
  };

  const redirectByRole = (email) => {
    window.location.href = isAdminEmail(email) ? 'admin.html' : 'user.html';
  };

  // --- Login ---
  window.handleLogin = async (e) => {
    e.preventDefault();
    hideError('login');
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-password').value;
    setLoading('login', true);
    try {
      await authSignIn(email, pass);
    } catch (err) {
      showError('login', 'Correo o contraseña incorrectos.');
      setLoading('login', false);
    }
  };

  // --- Register ---
  window.handleRegister = async (e) => {
    e.preventDefault();
    hideError('register');

    const email = document.getElementById('reg-email').value.trim();
    const pass = document.getElementById('reg-password').value;
    const name = document.getElementById('reg-name').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const contactName = document.getElementById('reg-contact-name').value.trim();
    const contactPhone = document.getElementById('reg-contact-phone').value.trim();
    const emergencyContact = `${contactName} | ${contactPhone}`;

    if (!contactName || !contactPhone) {
      showError('register', 'Por favor ingresa el nombre y teléfono del contacto de emergencia.');
      return;
    }
    if (isAdminEmail(email)) {
      showError('register', 'Este correo es reservado.');
      return;
    }

    setLoading('register', true);
    try {
      const data = await authSignUp(email, pass);
      await fsPatch(`users/${data.localId}`, {
        uid: data.localId,
        email: email,
        name: name,
        phone: phone,
        emergencyContact: emergencyContact,
        role: 'user',
      }, data.idToken);
    } catch (err) {
      showError('register', err.message);
      setLoading('register', false);
    }
  };

  // --- Google Login ---
  window.handleGoogleLogin = () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(provider)
      .catch((err) => {
        if (err.code === 'auth/popup-blocked') {
          alert('Por favor, permite las ventanas emergentes para iniciar sesión con Google.');
        } else {
          showError('login', 'Error de Google: ' + err.message);
        }
      });
  };

  // --- Logout ---
  window.handleLogout = () => {
    if (typeof window.dashboardCleanup === 'function') window.dashboardCleanup();
    sessionStorage.setItem('logout_in_progress', 'true');
    firebase.auth().signOut()
      .then(() => {
        clearSession();
        window.location.href = 'index.html';
      })
      .catch((err) => {
        sessionStorage.removeItem('logout_in_progress');
        alert('Error al cerrar sesión. Intenta de nuevo.');
      });
  };

})();
