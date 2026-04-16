// ===== USER.JS — SOS & GPS Tracking Logic =====

(function () {
  'use strict';
  console.log('--- AlertaEmergencia User Script V3.7 ---');

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
  let socket = null;

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
    if (!activeAlertId) {
      setStatus('success', '✅ Ubicación obtenida. Listo para enviar alerta.');
    }
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

    setSendingState(true);
    setStatus('warning', '📤 Enviando alerta de emergencia...');

    try {
      const tok = await getValidToken();
      const alertData = {
        uid:              session.uid,
        email:            session.email,
        name:             userProfile?.name || session.email.split('@')[0],
        phone:            userProfile?.phone || '',
        emergencyContact: userProfile?.emergencyContact || '',
        type:             selectedType,
        typeLabel:        getTypeLabel(selectedType),
        message:          msgInput.value.trim(),
        lat:              currentLat,
        lng:              currentLng,
        status:           'active',
      };

      const result = await fsAdd('alerts', alertData, tok);
      // Usar el ID real de PostgreSQL (_realId)
      activeAlertId = result._realId ? result._realId.toString() : result.name.split('/').pop();
      setAlertActive();
      setStatus('success', '🆘 ¡Alerta enviada! Seguimiento GPS activo cada 30 segundos.');

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
      // NO status field — don't override a potential cancel PATCH in flight
      await fsPatch(`alerts/${activeAlertId}`, {
        lat: currentLat,
        lng: currentLng,
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

  // ---- Reset UI completamente ----
  function resetAlertUI() {
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
  }

  // ---- CANCEL ALERT (two-tap to avoid accidental dismiss on mobile/PWA) ----
  let _cancelPending = false;
  let _cancelTimer = null;

  window.handleCancelAlert = async function () {
    if (!activeAlertId) return;

    if (!_cancelPending) {
      // First tap — enter confirm state
      _cancelPending = true;
      cancelBtnEl.textContent = '⚠️ ¿Seguro? Toca de nuevo';
      cancelBtnEl.style.cssText = 'background:rgba(231,76,60,0.25);border-color:#e74c3c;color:#e74c3c;' +
                                   'border-radius:2rem;padding:0.6rem 1.2rem;cursor:pointer;transition:all .2s;width:100%;font-weight:700';
      _cancelTimer = setTimeout(() => {
        // Revert if no second tap
        _cancelPending = false;
        cancelBtnEl.textContent = '✕ Cancelar alerta activa';
        cancelBtnEl.style.cssText = '';
      }, 4000);
      return;
    }

    // Second tap — confirmed, execute cancel
    clearTimeout(_cancelTimer);
    _cancelPending = false;

    const idToCancel = activeAlertId;

    // Reset UI IMMEDIATELY so user is never stuck
    resetAlertUI();
    setStatus('success', '✅ Alerta cancelada. Puedes enviar una nueva si es necesario.');

    // Notify server in background
    try {
      const tok = await getValidToken();
      await fsPatch(`alerts/${idToCancel}`, { status: 'cancelled' }, tok);
      console.log('[SOS] Alerta cancelada en servidor:', idToCancel);
    } catch (e) {
      console.warn('[SOS] Fallo al notificar cancelación:', e.message);
    }
  };

  // ---- Socket.io: escuchar actualizaciones del admin en tiempo real ----
  function initSocket() {
    try {
      socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });

      socket.on('connect', () => {
        console.log('[Socket User] Conectado para escuchar actualizaciones');
      });

      socket.on('update_alert', (rawAlert) => {
        // Normalizar el objeto de la alerta
        const alert = parseDoc(rawAlert);
        const alertId = (alert._id || alert.id || '').toString();

        // Solo nos importa nuestra alerta activa
        if (!activeAlertId || alertId !== activeAlertId.toString()) return;

        console.log('[Socket User] Actualización de mi alerta:', alert.status);

        if (alert.status === 'in_progress') {
          // Admin está yendo al rescate
          setStatus('success', '🚨 ¡Ayuda en camino! Tu alerta está siendo atendida.');
          showBanner('🚨 Ayuda en camino', '¡Alguien está yendo a ayudarte!', 'warning');
        } else if (alert.status === 'attended') {
          // Admin marcó como atendida
          resetAlertUI();
          setStatus('success', '✅ ¡Tu emergencia fue atendida! Gracias por usar AlertaEmergencia.');
          showBanner('✅ Emergencia atendida', '¡Tu solicitud de ayuda fue resuelta!', 'success');
        } else if (alert.status === 'cancelled') {
          // Cancelada (por admin u otro)
          resetAlertUI();
          setStatus('success', '✅ La alerta fue cerrada.');
        }
      });

      socket.on('disconnect', () => {
        console.warn('[Socket User] Desconectado del servidor');
      });
    } catch (e) {
      console.warn('[Socket User] No se pudo conectar Socket.io:', e.message);
    }
  }

  // ---- Banner de notificación flotante ----
  function showBanner(title, msg, type) {
    // Remover banner anterior si existe
    const existing = document.getElementById('alert-update-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'alert-update-banner';
    const bg = type === 'success' ? 'var(--success)' : 'var(--warning)';
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      background: ${bg}; color: #fff;
      padding: 1rem 1.5rem;
      display: flex; align-items: center; gap: 0.75rem;
      font-size: 1rem; font-weight: 700;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      animation: slideDown 0.3s ease;
    `;
    banner.innerHTML = `
      <span style="font-size:1.5rem">${title.split(' ')[0]}</span>
      <div>
        <div>${title.split(' ').slice(1).join(' ')}</div>
        <div style="font-weight:400;font-size:0.85rem;opacity:0.9">${msg}</div>
      </div>
      <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer">✕</button>
    `;
    document.body.prepend(banner);

    // Auto-remover después de 8 segundos
    setTimeout(() => banner.remove(), 8000);

    // Vibrar el dispositivo si está disponible
    if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  }

  // ---- Teardown (called by auth.js before logout) ----
  window.dashboardCleanup = function () {
    console.log('[User] Ejecutando limpieza antes de salir...');
    if (trackingInterval) clearInterval(trackingInterval);
    if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
    if (socket) socket.disconnect();
  };

  // ---- Helpers ----
  function getTypeLabel(type) {
    return { fisica: 'Peligro físico', accidente: 'Accidente', medica: 'Emergencia médica', otro: 'Otro' }[type] || type;
  }

  // Agregar keyframe de animación para el banner
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideDown {
      from { transform: translateY(-100%); }
      to { transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);

  // ---- INIT ----
  loadProfile();
  startGPS();
  initSocket();

})();
