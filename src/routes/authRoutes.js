const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const express = require('express');
const authController = require('../controllers/authController');
const { registerValidation, loginValidation } = require('../validations/userValidation');
const pool = require('../config/dbConfig');

module.exports = (io) => {
  const router = express.Router();

  // Asegúrate de que la carpeta 'public/media/users' exista
  const uploadDir = path.join(__dirname, '..', '..', 'public', 'media', 'users');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Configura Multer para guardar archivos en 'public/media/users'
  const storage = multer.memoryStorage(); // Usar memoria en lugar de guardar directamente en disco

  const upload = multer({
    storage: storage,
    limits: {
      fileSize: 5000000 // Limita el tamaño del archivo a 5MB (ajusta según tus necesidades)
    },
    fileFilter: (req, file, cb) => {
      // Acepta solo archivos de imagen
      if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
        return cb(new Error('Solo se admiten archivos de imagen.'), false);
      }
      cb(null, true);
    }
  });

  router.post('/register', upload.single('foto'), async (req, res) => {
    if (req.file) {
      const compressedFileName = `foto-${Date.now()}-${Math.round(Math.random() * 1E9)}.jpg`;
      const compressedFilePath = path.join(uploadDir, compressedFileName);

      // Comprimir la imagen
      await sharp(req.file.buffer)
        .resize(800) // Cambia el tamaño a 800px de ancho (ajusta según tus necesidades)
        .jpeg({ quality: 80 }) // Cambia la calidad de la imagen (ajusta según tus necesidades)
        .toFile(compressedFilePath);

      req.body.foto = path.join('media', 'users', compressedFileName).replace(/\\/g, '/');
    }

    const { error } = registerValidation(req.body);
    if (error) {
      return res.status(400).send(error.details[0].message);
    }

    authController.register(req, res, io); // Pass `io` to controller
  });

  router.post('/login', (req, res) => {
    const { error } = loginValidation(req.body);
    if (error) {
      return res.status(400).send(error.details[0].message);
    }
    authController.login(req, res, io); // Pass `io` to controller
  });

  // Ruta para obtener datos de un usuario específico por ID
  router.get('/user/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query('SELECT id_usuario, nombre, foto, socket_id, navegacion, telefono, placa, movil FROM usuarios WHERE id_usuario = $1', [id]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        user.foto = user.foto ? `${user.foto}` : null;
        res.json(user);
      } else {
        res.status(404).send('Usuario no encontrado');
      }
    } catch (err) {
      console.error(err);
      res.status(500).send('Error del servidor');
    }
  });

  // Ruta para obtener la lista de todos los usuarios
  router.get('/users', async (req, res) => {
    try {
      const allUsers = await pool.query('SELECT id_usuario, nombre, tipo, foto, socket_id, navegacion, telefono, placa, movil FROM usuarios');
      res.json(allUsers.rows);
    } catch (err) {
      console.error(err);
      res.status(500).send('Error al obtener la lista de usuarios.');
    }
  });

  // Ruta para editar un usuario
  router.put('/user/:id', upload.single('foto'), async (req, res) => {
    if (req.file) {
      const compressedFileName = `foto-${Date.now()}-${Math.round(Math.random() * 1E9)}.jpg`;
      const compressedFilePath = path.join(uploadDir, compressedFileName);

      // Comprimir la imagen
      await sharp(req.file.buffer)
        .resize(800) // Cambia el tamaño a 800px de ancho (ajusta según tus necesidades)
        .jpeg({ quality: 80 }) // Cambia la calidad de la imagen (ajusta según tus necesidades)
        .toFile(compressedFilePath);

      req.body.foto = path.join('media', 'users', compressedFileName).replace(/\\/g, '/');
    }
    authController.editUser(req, res, io); // Pass `io` to controller
  });

  // Ruta para eliminar un usuario
  router.delete('/user/:id', (req, res) => {
    authController.deleteUser(req, res, io); // Pass `io` to controller
  });

  // Ruta para cerrar sesión
  router.post('/logout', async (req, res) => {
    const { id_usuario } = req.body;
    try {
      await pool.query('UPDATE usuarios SET socket_id = NULL WHERE id_usuario = $1', [id_usuario]);
      res.status(200).send('Sesión cerrada');
      io.emit('userUpdate');
    } catch (error) {
      console.error('Error al cerrar sesión:', error);
      res.status(500).send('Error al cerrar sesión');
    }
  });

  // Ruta para obtener la lista de todos los usuarios
  router.get('/drivers', async (req, res) => {
    try {
      const allUsers = await pool.query("SELECT id_usuario, nombre, tipo, foto, socket_id, navegacion, telefono, placa, movil FROM usuarios WHERE usuarios.tipo = $1", ['tipo2']);
      res.json(allUsers.rows);
    } catch (err) {
      console.error(err);
      res.status(500).send('Error al obtener la lista de conductores.');
    }
  });

  return router;
};
