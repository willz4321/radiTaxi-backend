const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/dbConfig');
const geolocationController = require('../controllers/geolocationController');

// Configuración de almacenamiento de Multer para audios
const audioStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const audioDir = path.join(__dirname, '..', '..', 'public', 'media', 'audios');
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }
    cb(null, audioDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadAudio = multer({
  storage: audioStorage,
  fileFilter: function (req, file, cb) {
    const mimeTypes = ['audio/wav', 'audio/ogg', 'audio/opus'];
    if (mimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only WAV, OGG/OPUS audio is allowed.'));
    }
  }
});

module.exports = (io) => {
  router.post('/update-location', (req, res) => geolocationController.updateUserLocation(req, res, io));
  router.get('/get-location/:id_usuario', geolocationController.getUserLocation);
  router.get('/users', geolocationController.getAllUserLocations);

  router.post('/taxi-request', (req, res) => geolocationController.requestTaxi(req, res, io));
  router.post('/accept-taxi-request', (req, res) => geolocationController.acceptTaxiRequest(req, res, io));
  router.post('/retry-taxi-request', (req, res) => geolocationController.retryTaxiRequest(req, res, io));
  router.post('/reject-taxi-request', (req, res) => geolocationController.rejectTaxiRequest(req, res, io));
  router.get('/check-status/:viajeId', geolocationController.checkTaxiRequestStatus);

  router.post('/delivery-request', (req, res) => geolocationController.requestDelivery(req, res, io));
  router.post('/reservation-request', (req, res) => geolocationController.requestReservation(req, res, io));

  router.post('/update-status', geolocationController.updateStatus);
  router.get('/accepted-requests', geolocationController.getAcceptedRequests);
  router.get('/accepted-trip', geolocationController.getRequestByPhoneNumber);
  router.get('/pending-reservations', geolocationController.getPendingReservations);
  router.get('/driver-info/:id_viaje', geolocationController.getDriverInfoByTripId);
  router.get('/history/:id_usuario', geolocationController.getHistoryTrips);
  router.get('/history-by-client/:telefono_cliente', geolocationController.getHistoryTripsByPhone);
  router.get('/history-all', geolocationController.getHistoryAllTrips);
  router.get('/drivers', geolocationController.getDrivers);
  router.get('/driver-data/:id_usuario', geolocationController.getDriverInfo);
  router.get('/trip-info/:id_viaje', geolocationController.getTripInfo);

  router.post('/panic', (req, res) => geolocationController.panic(req, res, io));
  router.post('/panic2', (req, res) => geolocationController.panic2(req, res, io));

  // Ruta para manejar la subida de audios
  router.post('/upload-audio', uploadAudio.single('audio'), async (req, res) => {
    try {
      const audioUrl = '/media/audios/' + req.file.filename;
      const { filteredDrivers } = req.body;
  
      // Convertir filteredDrivers de JSON a array si es necesario
      const selectedDrivers = JSON.parse(filteredDrivers || '[]');
  
      // Obtener los socket IDs de los conductores seleccionados
      const result = await pool.query(
        'SELECT socket_id FROM usuarios WHERE id_usuario = ANY($1)',
        [selectedDrivers]
      );
      
      console.log("📌 RESULTADOS:", selectedDrivers);
  
      // Emitir el audio solo a los socket IDs de los conductores seleccionados
      result.rows.forEach(row => {
        io.to(row.socket_id).emit('new-audio', { audioUrl });
      });
  
      res.json({ audioUrl });
  
      // Eliminar el archivo después de 1 minuto (60,000 milisegundos)
      setTimeout(() => {
        const filePath = path.join(__dirname, '..', '..', 'public', audioUrl);
        fs.unlink(filePath, (err) => {
          if (err) {
            console.error('Error deleting audio:', err);
          } else {
            console.log(`Audio file deleted: ${filePath}`);
          }
        });
      }, 60000);
    } catch (error) {
      console.error('Error uploading audio:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  

  // Ruta para manejar la subida de audios
  router.post('/upload-audio-tipo2', uploadAudio.single('audio'), (req, res) => {
    try {
      const audioUrl = '/media/audios/' + req.file.filename;
      
      io.emit('new-audio-tipo2', { audioUrl });
      res.json({ audioUrl });

      // Eliminar el archivo después de 1 minuto (60,000 milisegundos)
      setTimeout(() => {
        const filePath = path.join(__dirname, '..', '..', 'public', audioUrl);
        fs.unlink(filePath, (err) => {
          if (err) {
            console.error('Error deleting audio:', err);
          } else {
            console.log(`Audio file deleted: ${filePath}`);
          }
        });
      }, 60000);
    } catch (error) {
      console.error('Error uploading audio:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/upload-audio-single', uploadAudio.single('audio'), async (req, res) => {
    try {
      const audioUrl = '/media/audios/' + req.file.filename;
      const { id_usuario } = req.body;
  
      if (!id_usuario) {
        return res.status(400).json({ error: 'id_usuario es requerido' });
      }
  
      const result = await pool.query('SELECT socket_id FROM usuarios WHERE id_usuario = $1', [id_usuario]);
  
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
  
      const socketId = result.rows[0].socket_id;
  
      if (socketId) {
        io.to(socketId).emit('new-audio-single', { audioUrl });
        console.log(`Audio enviado al usuario ${id_usuario} con socket ID ${socketId}`);
      } else {
        console.log(`Usuario ${id_usuario} no está conectado`);
      }
  
      res.json({ audioUrl });

      // Eliminar el archivo después de 1 minuto (60,000 milisegundos)
      setTimeout(() => {
        const filePath = path.join(__dirname, '..', '..', 'public', audioUrl);
        fs.unlink(filePath, (err) => {
          if (err) {
            console.error('Error deleting audio:', err);
          } else {
            console.log(`Audio file deleted: ${filePath}`);
          }
        });
      }, 60000);
    } catch (error) {
      console.error('Error uploading audio:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/suggestContacts', async (req, res) => {
    try {
      const result = await pool.query('SELECT telefono, nombre FROM contactos');
      res.json(result.rows);
    } catch (error) {
      console.error('Error fetching contact suggestions:', error);
      res.status(500).send('Internal server error');
    }
  });
  
  router.get('/suggestAddresses', async (req, res) => {
    const { userId } = req.query;
    console.log(`Solicitud de direcciones para ${userId}`);
    if (!userId) {
      return res.status(400).send('User ID is required');
    }
  
    try {
      const result = await pool.query(
        'SELECT direccion FROM direcciones WHERE id_usuario = $1',
        [userId]
      );
      res.json(result.rows.map(row => row.direccion));
    } catch (error) {
      console.error('Error fetching address suggestions:', error);
      res.status(500).send('Internal server error');
    }
  });

  // Función para responder inmediatamente a la solicitud
function respondImmediately(req, res) {
  res.status(200).json({ message: 'Solicitud recibida correctamente.' });
  console.log(`Received request at ${new Date().toISOString()}`);
}

// Ruta para recibir y procesar solicitudes POST a /requests
router.post('/requests', async (req, res) => {
  respondImmediately(req, res); // Responder inmediatamente a la solicitud

  const { company_id, request_type, request_data, status, conversation_id } = req.body;

  // Validar la estructura del request_data
  if (!company_id || !request_type || !request_data || !conversation_id) {
    console.log('Datos de la solicitud incompletos.');
    return;
  }

  // Procesar los datos recibidos
  console.log("Solicitud recibida: ", req.body);

  // Procesar en segundo plano
  try {
    // Verificar si es una solicitud de taxi
    if (request_type === 'taxi') {
      const {
        phone_number: clientId,
        name,
        pickup_location_name: address,
        dropoff_location_name: endAddress,
        pickup_location_latitude: latitude,
        dropoff_location_latitude: endLatitude,
        pickup_location_longitude: longitude,
        dropoff_location_longitude: endLongitude
      } = request_data;

      // Llamar a requestTaxi con los datos mapeados
      await geolocationController.requestTaxi({
        body: { clientId, name, latitude, longitude, address, endLatitude, endLongitude, endAddress }
      }, res, io);
    }

  } catch (error) {
    console.error("Error procesando la solicitud en segundo plano: ", error);
    // Aquí puedes agregar lógica adicional para manejar el error, como almacenar el error en una base de datos
  }
});


  return router;
};
