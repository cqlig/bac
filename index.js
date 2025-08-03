const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Verificar si existe el build de React, si no, construirlo
const buildPath = path.join(__dirname, '../client/build');
const indexPath = path.join(buildPath, 'index.html');

if (!fs.existsSync(buildPath) || !fs.existsSync(indexPath)) {
  console.log('🔨 Build de React no encontrado. Construyendo...');
  try {
    execSync('cd client && npm run build', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    console.log('✅ Build completado exitosamente');
  } catch (error) {
    console.error('❌ Error al construir React:', error.message);
    console.log('⚠️ Usando servidor sin archivos estáticos de React');
  }
}

// Servir archivos estáticos del build de React solo si existe
if (fs.existsSync(buildPath) && fs.existsSync(indexPath)) {
  app.use(express.static(buildPath));
  console.log('📁 Sirviendo archivos estáticos desde:', buildPath);
} else {
  console.log('⚠️ No se encontraron archivos de build de React');
}

// Inicializar base de datos SQLite
const db = new sqlite3.Database('./tickets.db', (err) => {
  if (err) {
    console.error('Error conectando a la base de datos:', err.message);
  } else {
    console.log('Conectado a la base de datos SQLite.');
  }
});

// Crear tabla si no existe
db.run(`CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  buyer_name TEXT NOT NULL,
  buyer_email TEXT,
  event_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'Válido',
  qr_code TEXT
)`);

// Rutas API
app.post('/api/tickets', async (req, res) => {
  try {
    const { buyer_name, buyer_email, event_name } = req.body;

    if (!buyer_name || !event_name) {
      return res.status(400).json({ error: 'Nombre del comprador y evento son requeridos' });
    }

    const id = uuidv4();
    const qr_code = await qrcode.toDataURL(id);

    db.run(
      'INSERT INTO tickets (id, buyer_name, buyer_email, event_name, qr_code) VALUES (?, ?, ?, ?, ?)',
      [id, buyer_name, buyer_email, event_name, qr_code],
      function(err) {
        if (err) {
          console.error(err);
          res.status(500).json({ error: 'Error creando el ticket' });
        } else {
          res.json({
            id,
            buyer_name,
            buyer_email,
            event_name,
            status: 'Válido',
            created_at: moment().format(),
            qr_code
          });
        }
      }
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/tickets', (req, res) => {
  db.all('SELECT * FROM tickets ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error obteniendo tickets' });
    } else {
      res.json(rows);
    }
  });
});

app.get('/api/tickets/:id', (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM tickets WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error obteniendo ticket' });
    } else if (!row) {
      res.status(404).json({ error: 'Ticket no encontrado' });
    } else {
      res.json(row);
    }
  });
});

app.post('/api/tickets/validate', (req, res) => {
  const { ticket_id } = req.body;

  if (!ticket_id) {
    return res.status(400).json({ error: 'ID del ticket es requerido' });
  }

  db.get('SELECT * FROM tickets WHERE id = ?', [ticket_id], (err, row) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error validando ticket' });
    } else if (!row) {
      res.json({ valid: false, message: 'Ticket no encontrado' });
    } else if (row.status === 'Canjeado') {
      res.json({ valid: false, message: 'Ticket ya fue canjeado', ticket: row });
    } else {
      res.json({ valid: true, message: 'Ticket válido', ticket: row });
    }
  });
});

app.post('/api/tickets/redeem', (req, res) => {
  const { ticket_id } = req.body;

  if (!ticket_id) {
    return res.status(400).json({ error: 'ID del ticket es requerido' });
  }

  db.run(
    'UPDATE tickets SET status = "Canjeado" WHERE id = ? AND status = "Válido"',
    [ticket_id],
    function(err) {
      if (err) {
        console.error(err);
        res.status(500).json({ error: 'Error canjeando ticket' });
      } else if (this.changes === 0) {
        res.status(400).json({ error: 'Ticket no encontrado o ya fue canjeado' });
      } else {
        res.json({ message: 'Ticket canjeado exitosamente' });
      }
    }
  );
});

app.delete('/api/tickets/:id', (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM tickets WHERE id = ?', [id], function(err) {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error eliminando ticket' });
    } else if (this.changes === 0) {
      res.status(404).json({ error: 'Ticket no encontrado' });
    } else {
      res.json({ message: 'Ticket eliminado exitosamente' });
    }
  });
});

// Servir React app para todas las rutas que no sean API
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../client/build', 'index.html');
  
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ 
      error: 'Frontend no disponible', 
      message: 'El build de React no se encontró. Ejecuta "npm run build" en el directorio client.' 
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎫 Servidor corriendo en puerto ${PORT}`);
  console.log(`📱 Aplicación disponible en: http://0.0.0.0:${PORT}`);
  console.log(`🌐 También disponible en: https://${process.env.REPL_SLUG || 'tu-repl'}.${process.env.REPL_OWNER || 'usuario'}.repl.co`);
});