// ===== USER.JS — SOS & GPS Tracking Logic =====

(function () {
  'use strict';
  console.log('--- AlertaEmergencia User Script V3.3 ---');

  // ---- Guard: require session ----
  const session = getSession();
  if (!session || !session.idToken) {
    window.location.href = 'index.html';
    return;
  }
  // Redirect admin away
  if (isAdminEmail(session.email)) {
    window.location.href = 'admin.html';
    return;
  }

  // ---- State ----
  let currentLat = null;
  let currentLng = null;
  let gpsReady = false;
  let selectedType = null;
  let activeAlertId = null;
  let trackingInterval = null;
  let userProfile = null;
  let geoWatchId = null;

  // ---- DOM refs ----
  const sosBtnEl     = document.getElementById('sos-btn');
  const sosLabelEl   = document.getElementById('sos-label');
  const sosSubEl     = document.getElementById('sos-sub');
  const cancelBtnEl  = document.getElementById('cancel-btn');
  const trackingBar  = document.getElementById('tracking-bar');
  const trackingText = document.getElementById('tracking-text');
  const statusBar    = document.getElementById('status-bar');
  const statusText   = document.getElementById('status-text');
  const gpsDot       = document.getElementById('gps-status-dot');
  const gpsTextEl    = document.getElementById('gps-status-text');
  const nameEl       = document.getElementById('user-display-name');
  const msgInput     = document.getElementById('msg-input');

  // ---- Load user profile ----
  async function loadProfile() {
    try {
      const tok = await getValidToken();
      const doc = await fsGet(`users/${session.uid}`, tok);
      userProfile = parseDoc(doc);
      if (userProfile.name) nameEl.textContent = userProfile.name;
    } catch (e) {
      console.warn('Could not load profile:', e.message);
      userProfile = { uid: session.uid, email: session.email, name: session.email.split('@')[0], phone: '', emergencyContact: '' };
      nameEl.textContent = userProfile.name;
    }
  }

  // ---- Token management ----
  async function getValidToken() {
    let s = getSession();
    if (!s) throw new Error('No session');
    if (Date.now() > s.expiresAt - 60000) {
      const refreshed = await refreshIdToken(s.refreshToken);
      s.idToken = refreshed.idToken;
      s.refreshToken = refreshed.refreshToken;
      s.expiresAt = Date.now() + 3590000;
      saveSession(s);
    }
    return s.idToken;
  }

  // ---- Geolocation ----
  function startGPS() {
    if (!navigator.geolocation) {
      setGPSError('GPS no disponible en este dispositivo');
      return;
    }
    setGPSSearching();
    geoWatchId = navigator.geolocation.watchPosition(
      onGPSSuccess,
      onGPSError,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }

  function onGPSSuccess(pos) {
    currentLat = pos.coords.latitude;
    currentLng = pos.coords.longitude;
    gpsReady = true;
    setGPSReady();
    // If we have an active alert, push location update
    if (activeAlertId) pushLocationUpdate();
  }

  function onGPSError(err) {
    const msgs = {
      1: 'Permiso de ubicación denegado. Por favor permite el acceso en tu navegador.',
      2: 'No se pudo obtener la ubicación.',
      3: 'Tiempo de espera al obtener ubicación.'
    };
    setGPSError(msgs[err.code] || 'Error de GPS');
  }

  function setGPSSearching() {
    gpsDot.className = 'gps-dot searching';
    gpsTextEl.textContent = 'Buscando GPS...';
    setStatus('warning', '📡 Obteniendo tu ubicación GPS...');
  }

  function setGPSReady() {
    gpsDot.className = 'gps-dot';
    gpsTextEl.textContent = 'GPS activo';
    setStatus('success', `✅ Ubicación obtenida. Listo para enviar alerta.`);
  }

  function setGPSError(msg) {
    gpsDot.className = 'gps-dot error';
    gpsTextEl.textContent = 'GPS no disponible';
    setStatus('error', '⚠️ ' + msg);
  }

  function setStatus(type, msg) {
    statusBar.className = 'status-bar' + (type === 'warning' ? ' warning' : type === 'error' ? ' error' : '');
    statusText.textContent = msg;
  }

  // ---- Emergency type selection ----
  window.selectType = function (type, btn) {
    selectedType = type;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  };

  // ---- SOS BUTTON ----
  window.handleSOS = async function () {
    if (activeAlertId) return; // already active
    if (!gpsReady || currentLat === null) {
      setStatus('error', '⚠️ Espera a que el GPS esté listo para enviar la alerta.');
      return;
    }
    if (!selectedType) {
      setStatus('warning', '⚠️ Por favor selecciona el tipo de emergencia primero.');
      return;
    }

    // UI: sending state
    setSendingState(true);
    setStatus('warning', '📤 Enviando alerta de emergencia...');

    try {
      const tok = await getValidToken();
      const alertData = {
        uid:          fsString(session.uid),
        email:        fsString(session.email),
        name:         fsString(userProfile?.name || session.email.split('@')[0]),
        phone:        fsString(userProfile?.phone || ''),
        emergencyContact: fsString(userProfile?.emergencyContact || ''),
        type:         fsString(selectedType),
        typeLabel:    fsString(getTypeLabel(selectedType)),
        message:      fsString(msgInput.value.trim()),
        lat:          fsNumber(currentLat),
        lng:          fsNumber(currentLng),
        timestamp:    fsTimestamp(),
        updatedAt:    fsTimestamp(),
        status:       fsString('active'),
      };

      const result = await fsAdd('alerts', alertData, tok);
      // Usar el ID real de PostgreSQL (_realId), no el path falso de Firestore
      activeAlertId = result._realId ? result._realId.toString() : result.name.split('/').pop();
      setAlertActive();
      setStatus('success', '🆘 ¡Alerta enviada! Seguimiento activo cada 30 segundos.');

      // Start tracking interval
      trackingInterval = setInterval(pushLocationUpdate, 30000);
    } catch (err) {
      setSendingState(false);
      setStatus('error', '❌ Error al enviar alerta: ' + err.message);
    }
  };

  async function pushLocationUpdate() {
    if (!activeAlertId || !gpsReady) return;
    try {
      const tok = await getValidToken();
      await fsPatch(`alerts/${activeAlertId}`, {
        lat:       fsNumber(currentLat),
        lng:       fsNumber(currentLng),
        updatedAt: fsTimestamp(),
        status:    fsString('active'),
      }, tok);
      const now = new Date();
      trackingText.textContent = `📍 Ubicación actualizada: ${now.toLocaleTimeString()}`;
    } catch (err) {
      console.warn('Tracking update failed:', err.message);
    }
  }

  function setAlertActive() {
    sosBtnEl.classList.add('active');
    sosLabelEl.textContent = '⚠️';
    sosSubEl.textContent = 'ALERTA ACTIVA';
    sosBtnEl.disabled = true;
    cancelBtnEl.classList.remove('hidden');
    trackingBar.classList.add('active-tracking');
    trackingText.textContent = '📡 Seguimiento GPS activo';
    msgInput.disabled = true;
    document.querySelectorAll('.type-btn').forEach(b => b.disabled = true);
  }

  function setSendingState(loading) {
    sosBtnEl.disabled = loading;
    if (loading) {
      sosLabelEl.innerHTML = '<span class="spinner"></span>';
      sosSubEl.textContent = 'ENVIANDO...';
    } else {
      sosLabelEl.textContent = 'SOS';
      sosSubEl.textContent = 'ENVIAR ALERTA';
    }
  }

  // ---- CANCEL ALERT ----
  window.handleCancelAlert = async function () {
    if (!activeAlertId) return;
    if (!confirm('¿Confirmas que deseas cancelar la alerta de emergencia?')) return;

    // Guardar el ID antes de resetear por si la petición lleva tiempo
    const idToCancel = activeAlertId;

    // Resetear estado local INMEDIATAMENTE (el usuario no debe quedar atrapado)
    clearInterval(trackingInterval);
    trackingInterval = null;
    activeAlertId = null;
    sosBtnEl.classList.remove('active');
    sosBtnEl.disabled = false;
    sosLabelEl.textContent = 'SOS';
    sosSubEl.textContent = 'ENVIAR ALERTA';
    cancelBtnEl.classList.add('hidden');
    trackingBar.classList.remove('active-tracking');
    trackingText.textContent = 'Sin seguimiento activo';
    msgInput.disabled = false;
    document.querySelectorAll('.type-btn').forEach(b => b.disabled = false);
    setStatus('success', '✅ Alerta cancelada. Puedes enviar una nueva si es necesario.');

    // Notificar al servidor (en segundo plano, no bloquea la UI)
    try {
      const tok = await getValidToken();
      await fsPatch(`alerts/${idToCancel}`, {
        status:    fsString('cancelled'),
        updatedAt: fsTimestamp(),
      }, tok);
    } catch (e) {
      console.warn('Cancel server notification failed (UI ya se reseteó):', e.message);
    }
  };

  // ---- Teardown (called by auth.js before logout) ----
  window.dashboardCleanup = function () {
    console.log('[User] Ejecutando limpieza antes de salir...');
    if (trackingInterval) clearInterval(trackingInterval);
    if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
  };

  // ---- Helpers ----
  function getTypeLabel(type) {
    return { fisica: 'Peligro físico', accidente: 'Accidente', medica: 'Emergencia médica', otro: 'Otro' }[type] || type;
  }

  // ---- Helpers exposed (already in firebase-config.js) ----
  // parseDoc, fsPatch, fsAdd, getSession, saveSession, refreshIdToken, etc.

  // ---- INIT ----
  loadProfile();
  startGPS();

})();
