require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH"]
  }
});

const port = process.env.PORT || 3000;

// Configuración Neon (PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

// === MIDDLEWARE DE AUTENTICACIÓN (FIREBASE) ===
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;

  if (!token) return res.status(401).json({ error: 'Token requerido' });
  
  if (!FIREBASE_API_KEY) {
    console.warn('Falta FIREBASE_API_KEY, permitiendo paso temporal (MODO DEV)');
    req.user = { localId: 'dev_user', email: ADMIN_EMAIL };
    return next();
  }

  try {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    });
    const data = await response.json();
    if (!response.ok || !data.users) throw new Error('Token inválido');
    req.user = data.users[0]; // req.user.localId, req.user.email
    next();
  } catch (error) {
    return res.status(403).json({ error: 'No autorizado' });
  }
}

// Middleware para restringir solo al administrador
function restrictToAdmin(req, res, next) {
  if (!req.user || !req.user.email) return res.status(403).json({ error: 'No identificado' });
  
  if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    return res.status(403).json({ error: 'Acceso denegado: Se requieren permisos de administrador' });
  }
  next();
}

// === RUTAS PARA USUARIOS ===
app.get('/api/users/:uid', verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;
    const result = await pool.query('SELECT * FROM users WHERE uid = $1', [uid]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users/:uid', verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;
    const fields = req.body;
    
    // Check if exists
    const check = await pool.query('SELECT uid FROM users WHERE uid = $1', [uid]);
    if (check.rows.length === 0) {
      // Create (Insert)
      await pool.query(
        'INSERT INTO users (uid, email, name, phone, emergency_contact, role) VALUES ($1, $2, $3, $4, $5, $6)',
        [uid, fields.email, fields.name || '', fields.phone || '', fields.emergencyContact || '', fields.role || 'user']
      );
      return res.json({ message: 'User created' });
    } else {
      // Update
      const updates = [];
      const values = [];
      let i = 1;
      for (const [key, val] of Object.entries(fields)) {
        updates.push(`${key} = $${i}`);
        values.push(val);
        i++;
      }
      values.push(uid);
      if (updates.length > 0) {
        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE uid = $${i}`, values);
      }
      return res.json({ message: 'User updated' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === RUTAS PARA ALERTAS ===
// Crear nueva alerta
app.post('/api/alerts', verifyToken, async (req, res) => {
  try {
    const { uid, email, name, phone, emergencyContact, type, typeLabel, message, lat, lng } = req.body;
    console.log('[API] Recibida nueva alerta de:', email);
    const result = await pool.query(
      `INSERT INTO alerts (uid, email, name, phone, emergency_contact, type, type_label, message, lat, lng, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active') RETURNING *`,
      [uid, email, name, phone, emergencyContact, type, typeLabel, message, lat, lng]
    );
    const alertData = result.rows[0];
    io.emit('new_alert', alertData); // Notificar a los admins
    res.json(alertData);
  } catch (err) {
    console.error('[API Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Listar alertas (admin)
app.get('/api/alerts', verifyToken, restrictToAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM alerts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/alerts/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    const { email: userEmail, localId: userUid } = req.user;
    const isAdmin = userEmail.toLowerCase() === ADMIN_EMAIL.toLowerCase();

    // Validar permiso: Admin o Dueño
    if (!isAdmin) {
      const check = await pool.query('SELECT uid FROM alerts WHERE id = $1', [id]);
      if (check.rows.length === 0) return res.status(404).json({ error: 'Alerta no encontrada' });
      if (check.rows[0].uid !== userUid) {
        return res.status(403).json({ error: 'No tienes permiso para actualizar esta alerta' });
      }
      // Un usuario normal solo puede cancelar o mover su propia alerta
      if (fields.status && fields.status !== 'cancelled' && fields.status !== 'active') {
        return res.status(403).json({ error: 'Solo el administrador puede cambiar el estado a ' + fields.status });
      }
    }

    const updates = [];
    const values = [];
    let i = 1;

    for (const [key, val] of Object.entries(fields)) {
      updates.push(`${key} = $${i}`);
      values.push(val);
      i++;
    }
    updates.push('updated_at = NOW()');
    values.push(id);
    
    const query = `UPDATE alerts SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`;
    const result = await pool.query(query, values);
    
    const updatedAlert = result.rows[0];
    io.emit('update_alert', updatedAlert);
    res.json(updatedAlert);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Script para inicializar tablas automáticamente
async function initDB() {
  if (!process.env.DATABASE_URL) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        uid VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255),
        name VARCHAR(255),
        phone VARCHAR(50),
        emergency_contact VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(255),
        email VARCHAR(255),
        name VARCHAR(255),
        phone VARCHAR(50),
        emergency_contact VARCHAR(255),
        type VARCHAR(100),
        type_label VARCHAR(255),
        message TEXT,
        lat DECIMAL(10, 8),
        lng DECIMAL(11, 8),
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Tablas preparadas en Neon PostgreSQL');
  } catch (error) {
    console.error('Error al iniciar base de datos:', error.message);
  }
}

server.listen(port, async () => {
  console.log(`Backend server con Socket.io corriendo en puerto ${port}`);
  await initDB();
});
