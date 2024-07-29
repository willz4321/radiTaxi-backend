require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./config/dbConfig');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');

const app = express();

// Configuración de Socket.io utilizando HTTP
const httpServer = http.createServer(app);
const io = socketIo(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.on('connection', (socket) => {
  console.log(`Nuevo cliente conectado: ${socket.id}`);
  
  socket.on('disconnect', () => {
  console.log(`Cliente desconectado: ${socket.id}`);
  });
  });
  
  io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);
  
  socket.on('registerUser', async (id_usuario) => {
  try {
  await pool.query('UPDATE usuarios SET socket_id = $1 WHERE id_usuario = $2', [socket.id, id_usuario]);
  console.log(`Usuario ${id_usuario} registrado con socket ID ${socket.id}`);
  socket.join(id_usuario); // Unirse a una sala específica para el usuario
  io.emit('userUpdate');
  } catch (err) {
  console.error('Error al registrar socket ID:', err);
  }
  });
  
  socket.on('disconnect', async () => {
  try {
  const result = await pool.query('SELECT id_usuario FROM usuarios WHERE socket_id = $1', [socket.id]);
  const id_usuario = result.rows[0]?.id_usuario;
  
      await pool.query('UPDATE usuarios SET socket_id = NULL WHERE socket_id = $1', [socket.id]);
    console.log(`Socket ID ${socket.id} ha sido removido`);
  
    if (id_usuario) {
      socket.leave(id_usuario); // Salir de la sala específica del usuario
    }
  
    io.emit('userUpdate');
  } catch (err) {
    console.error('Error al remover socket ID:', err);
  }
  });
  });

app.use(express.json());
app.use(cors());
app.use(session({
  secret: 'secret_key', // Reemplaza 'secret_key' por una clave secreta segura
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 1800000 } // 30 minutos
}));

const geolocationRoutes = require('./routes/geolocationRoutes')(io);
const authRoutes = require('./routes/authRoutes')(io); // Pass `io` to `authRoutes`

app.use('/api/auth', authRoutes);
app.use('/api/geolocation', geolocationRoutes);

// Middleware para servir archivos estáticos, incluyendo los archivos de audio
app.use('/media/audios', express.static(path.join(__dirname, '..', 'public', 'media', 'audios')));

// Middleware para servir archivos estáticos, incluyendo los archivos de audio
app.use('/media/notifications', express.static(path.join(__dirname, '..', 'public', 'media', 'notifications')));

// Middleware para servir archivos estáticos, incluyendo los archivos de audio
app.use('/media/users', express.static(path.join(__dirname, '..', 'public', 'media', 'users')));

app.get('/', (req, res) => {
  res.send('¡Hola Mundo!');
});

// Catch-all para enviar index.html para cualquier ruta que no coincida con las rutas API
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.get('/db', async (req, res) => {
  try {
    const response = await pool.query('SELECT NOW()');
    res.json(response.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al conectar con la base de datos');
  }
});

// Cerrar sesión al cerrar la ventana del navegador
app.get('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        console.error('Error al cerrar sesión:', err);
      }
      res.send('Sesión cerrada');
    });
  } else {
    res.end();
  }
});

// Escucha en el puerto asignado por Render o en un puerto predeterminado para desarrollo local
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en este puerto ${PORT}`);
});

module.exports = { app, httpServer, io };
