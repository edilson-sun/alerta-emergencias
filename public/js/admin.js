// ===== ADMIN.JS — Admin Dashboard Logic =====
// Real-time alert monitoring, Leaflet map, notifications

(function () {
  'use strict';

  // ---- Guard: require admin session ----
  const session = getSession();
  if (!session || !session.idToken) {
    window.location.href = 'index.html';
    return;
  }
  if (!isAdminEmail(session.email)) {
    window.location.href = 'user.html';
    return;
  }

  // ---- State ----
  let allAlerts = {};          // id -> alert object
  let map = null;
  let markers = {};            // id -> Leaflet marker
  let currentTab = 'active';
  let knownIds = new Set();    // already-seen alert IDs
  let pollInterval = null;
  let doneCount = 0;

  // ---- DOM refs ----
  const alertsList    = document.getElementById('alerts-list');
  const historyList   = document.getElementById('history-list');
  const emptyActive   = document.getElementById('empty-active');
  const emptyHistory  = document.getElementById('empty-history');
  const activeCount   = document.getElementById('active-count');
  const statActive    = document.getElementById('stat-active');
  const statDone      = document.getElementById('stat-done');
  const toastContainer = document.getElementById('toast-container');
  const alertSound    = document.getElementById('alert-sound');

  // ---- Token management ----
  async function getToken() {
    let s = getSession();
    if (!s) throw new Error('No session');
    if (Date.now() > s.expiresAt - 60000) {
      const r = await refreshIdToken(s.refreshToken);
      s.idToken = r.idToken; s.refreshToken = r.refreshToken;
      s.expiresAt = Date.now() + 3590000;
      saveSession(s);
    }
    return s.idToken;
  }

  // ---- Init Leaflet Map ----
  function initMap() {
    map = L.map('admin-map', { zoomControl: true }).setView([-1.831239, -78.183406], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
  }

  // ---- Custom map icon ----
  function makeIcon(status) {
    const color = status === 'active' ? '#e74c3c' : status === 'in_progress' ? '#f39c12' : '#27ae60';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
      <ellipse cx="18" cy="40" rx="8" ry="3" fill="rgba(0,0,0,0.3)"/>
      <path d="M18 0C9 0 2 7 2 16c0 12 16 28 16 28S34 28 34 16C34 7 27 0 18 0z" fill="${color}" stroke="white" stroke-width="2"/>
      <text x="18" y="20" text-anchor="middle" fill="white" font-size="14" font-family="Arial" font-weight="bold">!</text>
    </svg>`;
    return L.divIcon({
      html: svg, className: '', iconSize: [36, 44], iconAnchor: [18, 44], popupAnchor: [0, -44]
    });
  }

  // ---- Fetch all alerts ----
  async function fetchAlerts() {
    try {
      const tok = await getToken();
      const data = await fsList('alerts', tok);
      const docs = (data.documents || []).map(d => parseDoc(d));
      return docs;
    } catch (e) {
      console.warn('Fetch alerts error:', e.message);
      return [];
    }
  }

  // ---- Poll for new alerts ----
  async function pollAlerts() {
    const alerts = await fetchAlerts();
    const newActive = [];

    // Process each alert
    alerts.forEach(alert => {
      if (!alert._id) return;
      const existing = allAlerts[alert._id];
      allAlerts[alert._id] = alert;

      // New active alert?
      if (alert.status === 'active' && !knownIds.has(alert._id)) {
        knownIds.add(alert._id);
        newActive.push(alert);
      }

      // Update marker
      updateMarker(alert);
    });

    // Notify on new alerts
    if (newActive.length > 0) {
      newActive.forEach(a => showToast(a));
      playAlertSound();
      flashTitle(newActive.length);
    }

    renderLists();
    updateStats();
  }

  // ---- Map marker management ----
  function updateMarker(alert) {
    if (!alert.lat || !alert.lng) return;
    const pos = [parseFloat(alert.lat), parseFloat(alert.lng)];
    const label = getTypeEmoji(alert.type) + ' ' + alert.typeLabel;
    const time = alert.timestamp ? new Date(alert.timestamp).toLocaleTimeString() : '';

    const popupContent = `
      <div class="popup-content">
        <div class="popup-name">👤 ${escHtml(alert.name || 'Usuario')}</div>
        <div class="popup-type">${label}</div>
        <div class="popup-time">⏱️ ${time}</div>
        ${alert.phone ? `<div style="margin-top:4px;font-size:0.78rem">📞 <a href="tel:${escHtml(alert.phone)}" style="color:#e74c3c">${escHtml(alert.phone)}</a></div>` : ''}
        ${alert.message ? `<div style="margin-top:4px;font-size:0.78rem;color:#bdc3c7">"${escHtml(alert.message)}"</div>` : ''}
      </div>
    `;

    if (markers[alert._id]) {
      markers[alert._id].setLatLng(pos);
      if (alert.status === 'cancelled') {
        map.removeLayer(markers[alert._id]);
        delete markers[alert._id];
        return;
      }
      markers[alert._id].setIcon(makeIcon(alert.status));
      markers[alert._id].setPopupContent(popupContent);
    } else if (alert.status !== 'cancelled') {
      const marker = L.marker(pos, { icon: makeIcon(alert.status) })
        .addTo(map)
        .bindPopup(popupContent);
      markers[alert._id] = marker;

      // Fly to new alert
      if (alert.status === 'active') {
        map.flyTo(pos, 14, { duration: 1.5 });
        marker.openPopup();
      }
    }
  }

  // ---- Render alert lists ----
  function renderLists() {
    const active = Object.values(allAlerts).filter(a => a.status === 'active' || a.status === 'in_progress');
    const history = Object.values(allAlerts).filter(a => a.status === 'attended' || a.status === 'cancelled');

    active.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    history.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

    // Active
    activeCount.textContent = active.length;
    emptyActive.classList.toggle('hidden', active.length > 0);
    alertsList.innerHTML = active.map(renderAlertCard).join('');

    // History
    emptyHistory.classList.toggle('hidden', history.length > 0);
    historyList.innerHTML = history.map(renderHistoryCard).join('');

    doneCount = history.filter(a => a.status === 'attended').length;
  }

  function renderAlertCard(alert) {
    const time = alert.timestamp ? new Date(alert.timestamp).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
    const badge = alert.status === 'in_progress'
      ? '<span class="badge badge-progress">En proceso</span>'
      : '<span class="badge badge-active">Activa</span>';
    return `
      <div class="alert-card ${alert.status}" id="card-${alert._id}" onclick="focusAlert('${alert._id}')">
        <div class="alert-card-header">
          <span class="alert-name">👤 ${escHtml(alert.name || 'Sin nombre')}</span>
          <span class="alert-time">${time}</span>
        </div>
        ${badge}
        <div class="alert-type-label" style="margin-top:0.4rem">${getTypeEmoji(alert.type)} ${escHtml(alert.typeLabel || alert.type)}</div>
        ${alert.lat ? `<div class="alert-coords">📍 ${parseFloat(alert.lat).toFixed(5)}, ${parseFloat(alert.lng).toFixed(5)}</div>` : ''}
        ${alert.message ? `<div class="alert-message">"${escHtml(alert.message)}"</div>` : ''}
        <div class="alert-actions">
          ${alert.phone ? `<a href="tel:${escHtml(alert.phone)}" class="btn btn-secondary btn-sm" title="Llamar">📞 ${escHtml(alert.phone)}</a>` : ''}
          ${alert.status !== 'in_progress' ? `<button class="btn btn-warning btn-sm" onclick="updateStatus(event,'${alert._id}','in_progress')">⏳ En proceso</button>` : ''}
          <button class="btn btn-success btn-sm" onclick="updateStatus(event,'${alert._id}','attended')">✅ Atendida</button>
        </div>
      </div>`;
  }

  function renderHistoryCard(alert) {
    const time = alert.timestamp ? new Date(alert.timestamp).toLocaleString('es') : '';
    const badge = alert.status === 'attended'
      ? '<span class="badge badge-done">Atendida</span>'
      : '<span class="badge" style="background:rgba(149,165,166,0.2);color:#95a5a6;border:1px solid rgba(149,165,166,0.3)">Cancelada</span>';
    return `
      <div class="alert-card" style="opacity:0.7">
        <div class="alert-card-header">
          <span class="alert-name">👤 ${escHtml(alert.name || 'Sin nombre')}</span>
          <span class="alert-time">${time}</span>
        </div>
        ${badge}
        <div class="alert-type-label" style="margin-top:0.4rem">${getTypeEmoji(alert.type)} ${escHtml(alert.typeLabel || alert.type)}</div>
        ${alert.phone ? `<div class="alert-coords" style="margin-top:0.3rem">📞 ${escHtml(alert.phone)}</div>` : ''}
      </div>`;
  }

  function updateStats() {
    const active = Object.values(allAlerts).filter(a => a.status === 'active' || a.status === 'in_progress').length;
    const done = Object.values(allAlerts).filter(a => a.status === 'attended').length;
    statActive.textContent = active + ' activa' + (active !== 1 ? 's' : '');
    statDone.textContent = done + ' atendida' + (done !== 1 ? 's' : '');
    document.getElementById('admin-name-display').textContent = session.email.split('@')[0];
  }

  // ---- Focus alert on map ----
  window.focusAlert = function (id) {
    const alert = allAlerts[id];
    if (!alert || !alert.lat) return;
    map.flyTo([parseFloat(alert.lat), parseFloat(alert.lng)], 16, { duration: 1.2 });
    if (markers[id]) markers[id].openPopup();
    // Highlight card
    document.querySelectorAll('.alert-card').forEach(c => c.classList.remove('selected-alert'));
    const card = document.getElementById('card-' + id);
    if (card) card.classList.add('selected-alert');
  };

  // ---- Update alert status ----
  window.updateStatus = async function (e, id, status) {
    e.stopPropagation();
    try {
      const tok = await getToken();
      await fsPatch(`alerts/${id}`, {
        status: fsString(status),
        updatedAt: fsTimestamp()
      }, tok);
      if (allAlerts[id]) allAlerts[id].status = status;
      if (status === 'attended' && markers[id]) {
        if (markers[id]) markers[id].setIcon(makeIcon('attended'));
      }
      renderLists();
      updateStats();
    } catch (e) {
      console.error('Update status failed:', e.message);
    }
  };

  // ---- Tab switching ----
  window.switchTab = function (tab) {
    currentTab = tab;
    document.getElementById('tab-active').classList.toggle('active', tab === 'active');
    document.getElementById('tab-history').classList.toggle('active', tab === 'history');
    document.getElementById('panel-active').classList.toggle('hidden', tab !== 'active');
    document.getElementById('panel-history').classList.toggle('hidden', tab !== 'history');
  };

  // ---- Toast notification ----
  function showToast(alert) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <div class="toast-icon">${getTypeEmoji(alert.type)}</div>
      <div class="toast-body">
        <div class="toast-title">🆘 Nueva alerta — ${escHtml(alert.name || 'Usuario')}</div>
        <div class="toast-msg">${escHtml(alert.typeLabel || alert.type)} · ${alert.timestamp ? new Date(alert.timestamp).toLocaleTimeString() : ''}</div>
      </div>
    `;
    toastContainer.prepend(toast);
    setTimeout(() => toast.remove(), 6000);
  }

  // ---- Sound alert ----
  function playAlertSound() {
    try {
      // Generate a beep using Web Audio API
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
      console.warn('Audio failed:', e);
    }
  }

  // ---- Title flash ----
  let flashTimer = null;
  function flashTitle(count) {
    let state = true;
    const orig = 'AlertaEmergencia — Panel de Control';
    if (flashTimer) clearInterval(flashTimer);
    let flashes = 0;
    flashTimer = setInterval(() => {
      document.title = state ? `🆘 ${count} NUEVA${count > 1 ? 'S' : ''} ALERTA${count > 1 ? 'S' : ''}` : orig;
      state = !state;
      if (++flashes >= 10) { clearInterval(flashTimer); document.title = orig; }
    }, 700);
  }

  // ---- Logout ----
  window.handleLogout = function () {
    clearInterval(pollInterval);
    clearSession();
    window.location.href = 'index.html';
  };

  // ---- Helpers ----
  function getTypeEmoji(type) {
    return { fisica: '⚠️', accidente: '🚗', medica: '🏥', otro: '🔴' }[type] || '🔴';
  }
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ---- INIT ----
  initMap();
  pollAlerts();
  pollInterval = setInterval(pollAlerts, 5000); // poll every 5 seconds

})();
