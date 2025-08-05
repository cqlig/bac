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

// Inicializar base de datos SQLite
const db = new sqlite3.Database('./tickets.db', (err) => {
  if (err) {
    console.error('Error conectando a la base de datos:', err.message);
  } else {
    console.log('Conectado a la base de datos SQLite.');
  }
});

// Crear nueva tabla tickets y tabla qrs
db.serialize(() => {
  // Limpiar tablas existentes para evitar conflictos
  db.run('DROP TABLE IF EXISTS tickets');
  db.run('DROP TABLE IF EXISTS qrs');
  
  // Crear tabla tickets
  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    buyer_name TEXT NOT NULL,
    buyer_email TEXT,
    event_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'Válido',
    quantity INTEGER NOT NULL,
    price INTEGER NOT NULL,
    total INTEGER NOT NULL
  )`);
  
  // Crear tabla qrs con el nuevo sistema de usos
  db.run(`CREATE TABLE IF NOT EXISTS qrs (
    qr_id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    redeemed INTEGER DEFAULT 0,
    uses_remaining INTEGER NOT NULL,
    FOREIGN KEY(ticket_id) REFERENCES tickets(id)
  )`);
  
  console.log('✅ Base de datos inicializada con el nuevo sistema de QRs con múltiples usos');
});

// Rutas API
app.post('/api/tickets', async (req, res) => {
  try {
    const { buyer_name, buyer_email, event_name, quantity, price } = req.body;

    if (!buyer_name || !event_name || !quantity || !price) {
      return res.status(400).json({ error: 'Nombre del comprador, evento, cantidad y precio son requeridos' });
    }
    if (!buyer_name || !event_name) {
      return res.status(400).json({ error: 'Nombre del comprador y evento son requeridos' });
    }
    if (price <= 0) {
      return res.status(400).json({ error: 'El precio debe ser mayor a 0' });
    }
    if (quantity <= 0) {
      return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });
    }

    const id = uuidv4();
    const total = quantity * price;
    
    console.log('🎫 Creando ticket:', { buyer_name, quantity, price, total });
    
    // Insertar ticket
    db.run(
      'INSERT INTO tickets (id, buyer_name, buyer_email, event_name, quantity, price, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, buyer_name, buyer_email, event_name, quantity, price, total],
      async function(err) {
        if (err) {
          console.error('❌ Error creando ticket:', err);
          res.status(500).json({ error: 'Error creando el ticket' });
        } else {
          console.log('✅ Ticket creado exitosamente, ID:', id);
          
          // Generar 1 QR principal con múltiples usos
          const qr_id = uuidv4();
          const qr_image = await qrcode.toDataURL(qr_id);
          
          console.log('📱 Creando QR con usos:', { qr_id, quantity });
          
          // Guardar el QR con la cantidad de usos disponibles
          db.run('INSERT INTO qrs (qr_id, ticket_id, redeemed, uses_remaining) VALUES (?, ?, 0, ?)', 
            [qr_id, id, quantity], 
            function(err2) {
              if (err2) {
                console.error('❌ Error creando QR:', err2);
                res.status(500).json({ error: 'Error creando el QR' });
              } else {
                console.log('✅ QR creado exitosamente con', quantity, 'usos');
                res.json({
                  id,
                  buyer_name,
                  buyer_email,
                  event_name,
                  status: 'Válido',
                  created_at: moment().format(),
                  quantity,
                  price,
                  total,
                  qr: {
                    qr_id,
                    qr_image,
                    uses_remaining: quantity,
                    total_uses: quantity
                  }
                });
              }
            }
          );
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
  db.get('SELECT * FROM tickets WHERE id = ?', [id], (err, ticket) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error obteniendo ticket' });
    } else if (!ticket) {
      res.status(404).json({ error: 'Ticket no encontrado' });
    } else {
      // Obtener el QR principal asociado a este ticket
      db.get('SELECT qr_id, redeemed, uses_remaining FROM qrs WHERE ticket_id = ?', [id], async (err2, qr) => {
        if (err2) {
          console.error(err2);
          res.status(500).json({ error: 'Error obteniendo QR' });
        } else if (!qr) {
          res.status(404).json({ error: 'QR no encontrado' });
        } else {
          // Generar imagen QR
          const qr_image = await require('qrcode').toDataURL(qr.qr_id);
          const uses_consumed = ticket.quantity - qr.uses_remaining;
          
          res.json({ 
            ...ticket, 
            qr: {
              qr_id: qr.qr_id,
              qr_image,
              uses_remaining: qr.uses_remaining,
              uses_consumed,
              total_uses: ticket.quantity,
              is_fully_redeemed: qr.uses_remaining === 0
            }
          });
        }
      });
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

app.post('/api/qrs/redeem', (req, res) => {
  const { qr_id } = req.body;
  if (!qr_id) {
    return res.status(400).json({ error: 'ID del QR es requerido' });
  }
  
  // Verificar si el QR tiene usos disponibles
  db.get('SELECT uses_remaining FROM qrs WHERE qr_id = ?', [qr_id], (err, qr) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error verificando QR' });
    } else if (!qr) {
      res.status(404).json({ error: 'QR no encontrado' });
    } else if (qr.uses_remaining <= 0) {
      res.status(400).json({ error: 'QR sin usos disponibles' });
    } else {
      // Reducir un uso del QR
      db.run('UPDATE qrs SET uses_remaining = uses_remaining - 1 WHERE qr_id = ?', [qr_id], function(err2) {
        if (err2) {
          console.error(err2);
          res.status(500).json({ error: 'Error canjeando QR' });
        } else {
          const remaining = qr.uses_remaining - 1;
          res.json({ 
            message: `QR canjeado exitosamente. Usos restantes: ${remaining}`,
            uses_remaining: remaining
          });
        }
      });
    }
  });
});

// Ruta para eliminar ticket
app.delete('/api/tickets/:id', (req, res) => {
  const { id } = req.params;
  
  // Primero eliminar los QRs asociados
  db.run('DELETE FROM qrs WHERE ticket_id = ?', [id], function(err) {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error eliminando QRs del ticket' });
    } else {
      // Luego eliminar el ticket
      db.run('DELETE FROM tickets WHERE id = ?', [id], function(err2) {
        if (err2) {
          console.error(err2);
          res.status(500).json({ error: 'Error eliminando ticket' });
        } else if (this.changes === 0) {
          res.status(404).json({ error: 'Ticket no encontrado' });
        } else {
          res.json({ message: 'Ticket eliminado exitosamente' });
        }
      });
    }
  });
});

// Nueva ruta para obtener estadísticas
app.get('/api/stats', (req, res) => {
  db.all(`
    SELECT 
      COUNT(*) as total_tickets,
      SUM(CASE WHEN status = 'Válido' THEN 1 ELSE 0 END) as valid_tickets,
      SUM(CASE WHEN status = 'Canjeado' THEN 1 ELSE 0 END) as redeemed_tickets,
      SUM(CASE WHEN status = 'Válido' THEN total ELSE 0 END) as total_funds,
      SUM(CASE WHEN status = 'Válido' THEN quantity ELSE 0 END) as total_people,
      SUM(CASE WHEN status = 'Canjeado' THEN total ELSE 0 END) as redeemed_funds,
      SUM(CASE WHEN status = 'Canjeado' THEN quantity ELSE 0 END) as redeemed_people
    FROM tickets
  `, (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error obteniendo estadísticas' });
    } else {
      const stats = rows[0];
      res.json({
        total_tickets: stats.total_tickets || 0,
        valid_tickets: stats.valid_tickets || 0,
        redeemed_tickets: stats.redeemed_tickets || 0,
        total_funds: stats.total_funds || 0,
        total_people: stats.total_people || 0,
        redeemed_funds: stats.redeemed_funds || 0,
        redeemed_people: stats.redeemed_people || 0,
        pending_funds: (stats.total_funds || 0) - (stats.redeemed_funds || 0),
        pending_people: (stats.total_people || 0) - (stats.redeemed_people || 0)
      });
    }
  });
});

// Nueva ruta para obtener estadísticas de QRs
app.get('/api/qr-stats', (req, res) => {
  db.all(`
    SELECT 
      COUNT(*) as total_qrs,
      SUM(uses_remaining) as total_uses_remaining,
      SUM(CASE WHEN uses_remaining > 0 THEN 1 ELSE 0 END) as active_qrs,
      SUM(CASE WHEN uses_remaining = 0 THEN 1 ELSE 0 END) as fully_used_qrs
    FROM qrs
  `, (err, rows) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error obteniendo estadísticas de QRs' });
    } else {
      const stats = rows[0];
      res.json({
        total_qrs: stats.total_qrs || 0,
        total_uses_remaining: stats.total_uses_remaining || 0,
        active_qrs: stats.active_qrs || 0,
        fully_used_qrs: stats.fully_used_qrs || 0
      });
    }
  });
});

// Nueva ruta para validar QR individual
app.post('/api/qrs/validate', (req, res) => {
  const { qr_id } = req.body;
  if (!qr_id) {
    return res.status(400).json({ error: 'ID del QR es requerido' });
  }
  
  db.get('SELECT qr_id, uses_remaining, ticket_id FROM qrs WHERE qr_id = ?', [qr_id], (err, qr) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Error validando QR' });
    } else if (!qr) {
      res.json({ valid: false, message: 'QR no encontrado' });
    } else if (qr.uses_remaining <= 0) {
      res.json({ valid: false, message: 'QR sin usos disponibles', qr_id: qr.qr_id });
    } else {
      // Obtener información del ticket asociado
      db.get('SELECT * FROM tickets WHERE id = ?', [qr.ticket_id], (err2, ticket) => {
        if (err2) {
          console.error(err2);
          res.status(500).json({ error: 'Error obteniendo información del ticket' });
        } else {
          res.json({ 
            valid: true, 
            message: `QR válido. Usos restantes: ${qr.uses_remaining}`, 
            qr_id: qr.qr_id,
            uses_remaining: qr.uses_remaining,
            ticket: ticket
          });
        }
      });
    }
  });
});

// Ruta para eliminar un ticket y sus QRs asociados
app.delete('/api/tickets/:id', (req, res) => {
  const { id } = req.params;
  
  console.log('🗑️ Eliminando ticket:', id);
  
  // Primero eliminar los QRs asociados
  db.run('DELETE FROM qrs WHERE ticket_id = ?', [id], function(err) {
    if (err) {
      console.error('❌ Error eliminando QRs:', err);
      res.status(500).json({ error: 'Error eliminando QRs del ticket' });
    } else {
      console.log('✅ QRs eliminados para ticket:', id);
      
      // Luego eliminar el ticket
      db.run('DELETE FROM tickets WHERE id = ?', [id], function(err2) {
        if (err2) {
          console.error('❌ Error eliminando ticket:', err2);
          res.status(500).json({ error: 'Error eliminando el ticket' });
        } else {
          console.log('✅ Ticket eliminado exitosamente:', id);
          res.json({ message: 'Ticket eliminado exitosamente' });
        }
      });
    }
  });
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎫 Servidor corriendo en puerto ${PORT}`);
  console.log(`📱 Aplicación disponible en: http://0.0.0.0:${PORT}`);
  console.log(`🌐 También disponible en: https://${process.env.REPL_SLUG || 'tu-repl'}.${process.env.REPL_OWNER || 'usuario'}.repl.co`);
});