const bcrypt = require('bcryptjs');
const pool = require('../config/dbConfig');
const h3 = require('h3-js');
const axios = require('axios');

exports.updateUserLocation = async (req, res, io) => {
  const { id_usuario, latitude, longitude } = req.body;
  console.log(`Actualizando ubicación del usuario ${id_usuario} a latitud: ${latitude}, longitud: ${longitude}`);
  try {
    await pool.query(
      'UPDATE usuarios SET latitud = $1, longitud = $2 WHERE id_usuario = $3;',
      [latitude, longitude, id_usuario]
    );
    io.emit('locationUpdated', { id_usuario, latitude, longitude });
    console.log('Evento locationUpdated emitido', { id_usuario, latitude, longitude });
    res.status(200).send('Ubicación actualizada con éxito.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al actualizar la ubicación.');
  }
};

exports.getUserLocation = async (req, res) => {
  const { id_usuario } = req.params;

  try {
    const results = await pool.query(
      'SELECT latitud, longitud FROM usuarios WHERE id_usuario = $1;',
      [id_usuario]
    );
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener la ubicación.');
  }
};

exports.getAllUserLocations = async (req, res) => {
  try {
    const allUserLocations = await pool.query('SELECT * FROM usuarios;');
    res.json(allUserLocations.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener las ubicaciones de los usuarios.');
  }
};

exports.requestTaxi = async (req, res, io) => {
  let { clientId, name, latitude, longitude, address, endLatitude, endLongitude, endAddress } = req.body;
  console.log(`Recibida solicitud de taxi de ${name} en ${address} con latitud ${latitude} y longitud ${longitude}`);

  try {
    const contactExists = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM contactos WHERE telefono = $1)',
      [clientId]
    );

    if (!contactExists.rows[0].exists) {
      await pool.query(
        'INSERT INTO contactos (telefono, nombre) VALUES ($1, $2)',
        [clientId, name]
      );
    }

    // Function to normalize an address for checking existence
    const normalizeAddress = (direccion) => {
      return direccion.replace(/\s+/g, ' ').trim().toLowerCase();
    };

    // Function to check if an address exists for the user and return coordinates if it exists
    const getAddressCoordinates = async (userId, direccion) => {
      const normalizedDireccion = normalizeAddress(direccion);
      const result = await pool.query(
        `SELECT latitud, longitud FROM direcciones WHERE id_usuario = $1 AND
          LOWER(TRIM(BOTH FROM REGEXP_REPLACE(direccion, '\\s+', ' ', 'g'))) = $2`,
        [userId, normalizedDireccion]
      );
      return result.rows.length ? { latitud: result.rows[0].latitud, longitud: result.rows[0].longitud } : null;
    };

    // Function to insert a new address
    const insertAddress = async (userId, direccion, latitud, longitud) => {
      await pool.query(
        'INSERT INTO direcciones (id_usuario, direccion, latitud, longitud) VALUES ($1, $2, $3, $4)',
        [userId, direccion, latitud, longitud]
      );
    };

    // Check and insert start address if it doesn't exist
    let startCoords = await getAddressCoordinates(clientId, address);
    if (startCoords) {
      latitude = startCoords.latitud;
      longitude = startCoords.longitud;
    } else {
      if (!latitude || !longitude) {
        startCoords = await getGeocoding(address);
        if (!startCoords) {
          return res.status(400).send('No se pudo obtener las coordenadas de la dirección de inicio.');
        }
        latitude = startCoords.latitude;
        longitude = startCoords.longitude;
      }
      await insertAddress(clientId, address, latitude, longitude);
    }

    // Check and insert end address if it doesn't exist
    let endCoords = await getAddressCoordinates(clientId, endAddress);
    if (endCoords) {
      endLatitude = endCoords.latitud;
      endLongitude = endCoords.longitud;
    } else {
      if (!endLatitude || !endLongitude) {
        endCoords = await getGeocoding(endAddress);
        if (!endCoords) {
          return res.status(400).send('No se pudo obtener las coordenadas de la dirección de fin.');
        }
        endLatitude = endCoords.latitude;
        endLongitude = endCoords.longitude;
      }
      await insertAddress(clientId, endAddress, endLatitude, endLongitude);
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error('Latitude or longitude arguments were outside of acceptable range');
    }

    const insertQuery = `
      INSERT INTO viajes (telefono_cliente, estado, direccion, latitud, longitud, direccion_fin, latitud_fin, longitud_fin, fecha_hora_inicio, retry_count, tipo)
      VALUES ($1, 'pendiente', $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, 0, 'taxi') RETURNING id_viaje;
    `;
    const values = [clientId, address, latitude, longitude, endAddress, endLatitude, endLongitude];
    const insertResult = await pool.query(insertQuery, values);
    const viajeId = insertResult.rows[0].id_viaje;

    io.emit('taxiRequestPending', { latitude, longitude, range: 1000, viajeId });
    await handleTaxiRequestCycle(latitude, longitude, 1000, viajeId, io, 'taxi', address, endAddress, name);

    res.status(200).send('Solicitud de taxi enviada a los conductores cercanos.');
  } catch (error) {
    console.error('Error al insertar viaje en la base de datos:', error);
    res.status(500).send('Error al procesar la solicitud de taxi.');
  }
};

exports.requestDelivery = async (req, res, io) => {
  let { clientId, name, latitude, longitude, pickupAddress, deliveryLatitude, deliveryLongitude, deliveryAddress, description } = req.body;
  console.log(`Recibida solicitud de domicilio de ${name} en ${pickupAddress} con latitud ${latitude} y longitud ${longitude}`);

  try {
    const contactExists = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM contactos WHERE telefono = $1)',
      [clientId]
    );

    if (!contactExists.rows[0].exists) {
      await pool.query(
        'INSERT INTO contactos (telefono, nombre) VALUES ($1, $2)',
        [clientId, name]
      );
    }

    if (!latitude || !longitude) {
      const startCoords = await getGeocoding(pickupAddress);
      if (!startCoords) {
        return res.status(400).send('No se pudo obtener las coordenadas de la dirección de recogida.');
      }
      latitude = startCoords.latitude;
      longitude = startCoords.longitude;
    }

    if (!deliveryLatitude || !deliveryLongitude) {
      const endCoords = await getGeocoding(deliveryAddress);
      if (!endCoords) {
        return res.status(400).send('No se pudo obtener las coordenadas de la dirección de entrega.');
      }
      deliveryLatitude = endCoords.latitude;
      deliveryLongitude = endCoords.longitude;
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error('Latitude or longitude arguments were outside of acceptable range');
    }

    const insertQuery = `
      INSERT INTO viajes (telefono_cliente, estado, direccion, latitud, longitud, direccion_fin, latitud_fin, longitud_fin, fecha_hora_inicio, retry_count, tipo, descripcion)
      VALUES ($1, 'pendiente', $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, 0, 'delivery', $8) RETURNING id_viaje;
    `;
    const values = [clientId, pickupAddress, latitude, longitude, deliveryAddress, deliveryLatitude, deliveryLongitude, description];
    const insertResult = await pool.query(insertQuery, values);
    const viajeId = insertResult.rows[0].id_viaje;

    io.emit('deliveryRequestPending', { latitude, longitude, range: 1000, viajeId });
    await handleTaxiRequestCycle(latitude, longitude, 1000, viajeId, io, 'delivery', pickupAddress, deliveryAddress, name, description);

    res.status(200).send('Solicitud de domicilio enviada a los conductores cercanos.');
  } catch (error) {
    console.error('Error al insertar viaje en la base de datos:', error);
    res.status(500).send('Error al procesar la solicitud de domicilio.');
  }
};

const handleTaxiRequestCycle = async (latitude, longitude, range, viajeId, io, tipo, address, endAddress, name, descripcion) => {
  let attempt = 1;
  let maxAttempts = 3;
  let status = 'pendiente';

  while (attempt <= maxAttempts && status === 'pendiente') {
    console.log(`Ciclo de solicitud de ${tipo}, intento ${attempt} con rango ${range}`);

    const nearbyTaxis = await findNearbyTaxis(latitude, longitude, range);

    nearbyTaxis.forEach(taxi => {
      console.log(`Enviando solicitud de ${tipo} a ${taxi.id_usuario} con socket ID ${taxi.socketId}`);
      io.to(taxi.socketId).emit(`${tipo}Request`, { latitude, longitude, viajeId, address, endAddress, name, descripcion });
    });

    io.emit(`${tipo}RequestPending`, { latitude, longitude, range, viajeId });

    await new Promise(resolve => setTimeout(resolve, 12000));

    const result = await pool.query(
      'SELECT estado FROM viajes WHERE id_viaje = $1',
      [viajeId]
    );

    if (result.rowCount === 0) {
      console.error('Viaje no encontrado');
      return;
    }

    status = result.rows[0].estado;

    if (status === 'pendiente') {
      range *= 1.5;
      attempt += 1;
      await pool.query(
        'UPDATE viajes SET retry_count = retry_count + 1 WHERE id_viaje = $1',
        [viajeId]
      );
    }
  }

  if (status === 'pendiente') {
    console.log(`Rechazando solicitud de ${tipo} por falta de respuesta después de 3 intentos`);
    await pool.query(
      'UPDATE viajes SET estado = $1 WHERE id_viaje = $2',
      ['rechazado', viajeId]
    );
    io.emit(`${tipo}RequestRejected`, { id_viaje: viajeId, latitude, longitude });
  }
};

exports.requestReservation = async (req, res, io) => {
  let { clientId, name, latitude, longitude, address, endLatitude, endLongitude, endAddress, fecha_reserva, hora_reserva } = req.body;
  console.log(`Recibida solicitud de reserva de ${name} en ${address} con latitud ${latitude} y longitud ${longitude}`);

  try {
      const contactExists = await pool.query(
          'SELECT EXISTS(SELECT 1 FROM contactos WHERE telefono = $1)',
          [clientId]
      );

      if (!contactExists.rows[0].exists) {
          await pool.query(
              'INSERT INTO contactos (telefono, nombre) VALUES ($1, $2)',
              [clientId, name]
          );
      }

      if (!latitude || !longitude) {
          const startCoords = await getGeocoding(address);
          if (!startCoords) {
              return res.status(400).send('No se pudo obtener las coordenadas de la dirección de inicio.');
          }
          latitude = startCoords.latitude;
          longitude = startCoords.longitude;
      }

      if (!endLatitude || !endLongitude) {
          const endCoords = await getGeocoding(endAddress);
          if (!endCoords) {
              return res.status(400).send('No se pudo obtener las coordenadas de la dirección de fin.');
          }
          endLatitude = endCoords.latitude;
          endLongitude = endCoords.longitude;
      }

      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
          throw new Error('Latitude or longitude arguments were outside of acceptable range');
      }

      const insertQuery = `
          INSERT INTO viajes (telefono_cliente, estado, direccion, latitud, longitud, direccion_fin, latitud_fin, longitud_fin, fecha_reserva, hora_reserva, tipo)
          VALUES ($1, 'pendiente', $2, $3, $4, $5, $6, $7, $8, $9, 'reserva') RETURNING id_viaje;
      `;
      const values = [clientId, address, latitude, longitude, endAddress, endLatitude, endLongitude, fecha_reserva, hora_reserva];
      const insertResult = await pool.query(insertQuery, values);
      const viajeId = insertResult.rows[0].id_viaje;

      io.emit('reservationRequestPending', { latitude, longitude, range: 5000, viajeId, fecha_reserva, hora_reserva, address, endAddress, name });
      await handleReservationRequest(viajeId, io, latitude, longitude, fecha_reserva, hora_reserva, address, endAddress, name);

      res.status(200).send('Solicitud de reserva enviada a los conductores cercanos.');
  } catch (error) {
      console.error('Error al insertar la reserva en la base de datos:', error);
      res.status(500).send('Error al procesar la solicitud de reserva.');
  }
};

const handleReservationRequest = async (viajeId, io, latitude, longitude, fecha_reserva, hora_reserva, address, endAddress, name) => {
  try {
      const result = await pool.query('SELECT fecha_reserva, hora_reserva FROM viajes WHERE id_viaje = $1', [viajeId]);

      if (result.rowCount === 0) {
          console.error('Reserva no encontrada');
          return;
      }

      const { fecha_reserva, hora_reserva } = result.rows[0];
      const reservationDate = new Date(`${fecha_reserva}T${hora_reserva}`);
      const twoHoursBefore = new Date(reservationDate.getTime() - 2 * 60 * 60 * 1000);
      const now = new Date();

      if (now >= twoHoursBefore) {
          await pool.query('UPDATE viajes SET estado = $1 WHERE id_viaje = $2', ['rechazado', viajeId]);
          io.emit('reservationRequestRejected', { id_viaje: viajeId });
          return;
      }

      const range = 5000; // 5 km
      const nearbyTaxis = await findNearbyTaxis(latitude, longitude, range);

      nearbyTaxis.forEach(taxi => {
          io.to(taxi.socketId).emit('reservationRequest', { latitude, longitude, range, viajeId, fecha_reserva, hora_reserva, address, endAddress, name });
      });

      const interval = setInterval(async () => {
          const now = new Date();
          if (now >= twoHoursBefore) {
              clearInterval(interval);
              await pool.query('UPDATE viajes SET estado = $1 WHERE id_viaje = $2', ['rechazado', viajeId]);
              io.emit('reservationRequestRejected', { id_viaje: viajeId });
          } else {
              const result = await pool.query('SELECT estado FROM viajes WHERE id_viaje = $1', [viajeId]);
              if (result.rowCount === 0 || result.rows[0].estado !== 'pendiente') {
                  clearInterval(interval);
              }
          }
      }, 5 * 60 * 1000); // Verificar cada 5 minutos
  } catch (error) {
      console.error('Error al manejar la solicitud de reserva:', error);
  }
};

async function reportTravelStatus(action, travelInfo) {
  const url = 'https://botix.axiomarobotics.com:10000/bot';
  const botCredentials = {
    email: 'radiotaxibot@bot.botix',
    password: '123456'
  };

  const payload = {
    action,
    travelInfo,
    botCredentials
  };

  try {
    const response = await axios.post(url, payload);
    console.log(`Reporte de viaje ${action} enviado con éxito:`, response.data);
  } catch (error) {
    console.error(`Error al enviar el reporte de viaje ${action}:`, error);
  }
}

exports.acceptTaxiRequest = async (req, res, io) => {
  const { id_viaje, id_taxista } = req.body;
  console.log(`Recibida solicitud de aceptación del viaje con id_viaje: ${id_viaje} y id_taxista: ${id_taxista}`);

  try {
    const updateQuery = `
      UPDATE viajes
      SET id_taxista = $1, estado = 'aceptado', fecha_hora_inicio = CURRENT_TIMESTAMP
      WHERE id_viaje = $2 AND estado = 'pendiente' RETURNING *;`;

    const updateResult = await pool.query(updateQuery, [id_taxista, id_viaje]);

    if (updateResult.rowCount === 0) {
      console.log('El viaje ya ha sido asignado a otro taxista o no se encontró');
      res.status(409).send('El viaje ya ha sido asignado a otro taxista o no se encontró.');
    } else {
      console.log('Viaje actualizado con éxito:', updateResult.rows[0]);
      console.log('Emitiendo evento taxiRequestAccepted', { id_viaje: id_viaje, latitude: updateResult.rows[0].latitud, longitude: updateResult.rows[0].longitud });
      io.emit('taxiRequestAccepted', { id_viaje: id_viaje, latitude: updateResult.rows[0].latitud, longitude: updateResult.rows[0].longitud });

      const viajeInfo = await pool.query(
        `SELECT v.direccion, v.latitud, v.longitud, v.direccion_fin, v.latitud_fin, v.longitud_fin, 
                c.nombre, c.telefono, v.descripcion, v.hora_reserva, v.fecha_reserva, v.tipo
         FROM viajes v 
         JOIN contactos c ON v.telefono_cliente = c.telefono 
         WHERE v.id_viaje = $1`,
        [id_viaje]
      );
      const { direccion, latitud, longitud, direccion_fin, latitud_fin, longitud_fin, nombre, telefono, descripcion, hora_reserva, fecha_reserva, tipo } = viajeInfo.rows[0];

      const taxistaInfo = await pool.query(
        'SELECT * FROM usuarios WHERE id_usuario = $1',
        [id_taxista]
      );
      const txInfo = taxistaInfo.rows[0];
      const socket_id = txInfo.socket_id;
      //const { socket_id } = taxistaInfo.rows[0];

      io.to(socket_id).emit('assignedTaxi', { id_viaje, nombre, telefono, direccion, latitud, longitud, direccion_fin, latitud_fin, longitud_fin, descripcion, hora_reserva, fecha_reserva, tipo });

      // Reportar la aceptación del viaje
      await reportTravelStatus('accepted', {
        id_viaje,
        id_taxista,
        movil: txInfo.movil,
        placa: txInfo.placa,
        nombre_taxista: txInfo.nombre,
        longitud_taxista: txInfo.longitud,
        latitud_taxista: txInfo.latitud,
        nombre,
        telefono,
        direccion,
        latitud,
        longitud,
        direccion_fin,
        latitud_fin,
        longitud_fin,
        descripcion,
        hora_reserva,
        fecha_reserva,
        tipo
      });

    //   "travelInfo": {
    //     "id_viaje": 12345,
    //     "id_taxista": 67890,
    //     "nombre": "Jorge",
    //     "telefono": "573187771795",
    //     "direccion": "123 Main St",
    //     "latitud": 1.21242628983914,
    //     "longitud": -77.28792411408571,
    //     "direccion_fin": "456 Elm St",
    //     "latitud_fin": 40.73061,
    //     "longitud_fin": -73.935242,
    //     "descripcion": "Viaje de prueba",
    //     "hora_reserva": "14:00",
    //     "fecha_reserva": "2024-07-20",
    //     "tipo": "taxi",
    //     "movil": "34",
    //     "placa": "ABC123",
    //     "nombre_taxista": "Juan Pérez",
    //     "longitud_taxista": -77.2782701497968,
    //     "latitud_taxista": 1.2146903057311205
    //   },

      res.status(200).json(updateResult.rows[0]);
    }
  } catch (error) {
    console.error('Error al aceptar el viaje en la base de datos:', error);
    if (!res.headersSent) {
      res.status(500).send('Error al procesar la aceptación del viaje.');
    }
  }
};

exports.retryTaxiRequest = async (req, res, io) => {
  const { latitude, longitude, range, viajeId } = req.body;
  console.log(`Reintentando solicitud de taxi para el viaje ${viajeId} con rango ${range}`);
  
  try {
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error('Latitude or longitude arguments were outside of acceptable range');
    }

    const result = await pool.query(
      'UPDATE viajes SET retry_count = retry_count + 1 WHERE id_viaje = $1 RETURNING retry_count, estado',
      [viajeId]
    );

    if (result.rows[0].retry_count >= 3) {
      console.log('Rechazando solicitud de taxi por falta de respuesta después de 3 intentos');
      await pool.query(
        'UPDATE viajes SET estado = $1 WHERE id_viaje = $2',
        ['rechazado', viajeId]
      );
      io.emit('taxiRequestRejected', { id_viaje: viajeId, latitude, longitude });
      return res.status(200).send('Solicitud de taxi rechazada por falta de respuesta.');
    }

    const nearbyTaxis = await findNearbyTaxis(latitude, longitude, range);

    nearbyTaxis.forEach(taxi => {
      console.log(`Enviando solicitud de taxi a ${taxi.id_usuario} con socket ID ${taxi.socketId}`);
      io.to(taxi.socketId).emit('taxiRequest', { latitude, longitude, viajeId });
    });

    io.emit('taxiRequestPending', { latitude, longitude, range, viajeId });

    res.status(200).send('Reintento de solicitud de taxi enviado.');
  } catch (error) {
    console.error('Error al reintentar la solicitud de taxi:', error);
    res.status(500).send('Error al reintentar la solicitud de taxi.');
  }
};

exports.rejectTaxiRequest = async (req, res, io) => {
  const { id_viaje } = req.body;
  console.log(`Rechazando solicitud de taxi con id_viaje: ${id_viaje}`);

  try {
    const updateQuery = `
      UPDATE viajes
      SET estado = 'rechazado'
      WHERE id_viaje = $1 RETURNING *;`;

    const updateResult = await pool.query(updateQuery, [id_viaje]);

    if (updateResult.rowCount === 0) {
      console.log('No se encontró el viaje para rechazar');
      res.status(409).send('No se encontró el viaje para rechazar.');
    } else {
      console.log('Viaje rechazado con éxito:', updateResult.rows[0]);
      console.log('Emitiendo evento taxiRequestRejected', { id_viaje: id_viaje, latitude: updateResult.rows[0].latitud, longitude: updateResult.rows[0].longitud });
      io.emit('taxiRequestRejected', { id_viaje: id_viaje, latitude: updateResult.rows[0].latitud, longitude: updateResult.rows[0].longitud });
      res.status(200).json(updateResult.rows[0]);
    }
  } catch (error) {
    console.error('Error al rechazar el viaje en la base de datos:', error);
    if (!res.headersSent) {
      res.status(500).send('Error al procesar el rechazo del viaje.');
    }
  }
};

exports.checkTaxiRequestStatus = async (req, res) => {
  const { viajeId } = req.params;

  try {
    const result = await pool.query(
      'SELECT estado FROM viajes WHERE id_viaje = $1',
      [viajeId]
    );

    if (result.rowCount === 0) {
      res.status(404).send('Viaje no encontrado');
    } else {
      res.status(200).json(result.rows[0]);
    }
  } catch (error) {
    console.error('Error al verificar el estado del viaje:', error);
    res.status(500).send('Error al verificar el estado del viaje.');
  }
};

const findNearbyTaxis = async (latitude, longitude, range) => {
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error('Latitude or longitude arguments were outside of acceptable range');
  }

  const clientIndex = h3.latLngToCell(latitude, longitude, 9);
  const nearbyIndices = h3.gridDisk(clientIndex, Math.ceil(range / 1000));

  const allTaxis = await pool.query('SELECT id_usuario, socket_id, latitud, longitud FROM usuarios WHERE tipo = $1', ['tipo2']);

  const nearbyTaxis = allTaxis.rows.filter(taxi => {
    const taxiIndex = h3.latLngToCell(taxi.latitud, taxi.longitud, 9);
    return nearbyIndices.includes(taxiIndex);
  });
  console.log('Taxistas cercanos:', nearbyTaxis);
  return nearbyTaxis.map(taxi => ({ socketId: taxi.socket_id, ...taxi }));
};

async function getGeocoding(address) {
  try {
    const response = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${process.env.GOOGLE_MAPS_API_KEY}`);
    if (response.data.status !== 'OK') {
      console.error('Geocoding error:', response.data.status);
      return null;
    }

    const { lat, lng } = response.data.results[0].geometry.location;
    return { latitude: lat, longitude: lng };
  } catch (error) {
    console.error('Error during geocoding:', error);
    return null;
  }
}

exports.updateStatus = async (req, res) => {
  const { id_viaje, estado } = req.body;
  console.log(`solicitud de cambio de estado para el viaje ${id_viaje}`)

  try {
    const result = await pool.query(
      'UPDATE viajes SET estado = $1 WHERE id_viaje = $2 RETURNING *;',
      [estado, id_viaje]
    );

    if (result.rowCount === 0) {
      return res.status(404).send('Viaje no encontrado');
    }
    const viajeInfo = await pool.query(
      `SELECT v.direccion, v.latitud, v.longitud, v.direccion_fin, v.latitud_fin, v.longitud_fin, 
              c.nombre, c.telefono, v.descripcion, v.hora_reserva, v.fecha_reserva, v.tipo
       FROM viajes v 
       JOIN contactos c ON v.telefono_cliente = c.telefono 
       WHERE v.id_viaje = $1`,
      [id_viaje]
    );
    console.log(result)
    const { direccion, latitud, longitud, direccion_fin, latitud_fin, longitud_fin, nombre, telefono, descripcion, hora_reserva, fecha_reserva, tipo } = viajeInfo.rows[0];

    const taxistaInfo = await pool.query(
      'SELECT * FROM usuarios WHERE id_usuario = $1',
      [id_taxista]
    );
    const txInfo = taxistaInfo.rows[0];

    await reportTravelStatus(estado, {
      id_viaje,
      id_taxista,
      movil: txInfo.movil,
      placa: txInfo.placa,
      nombre_taxista: txInfo.nombre,
      longitud_taxista: txInfo.longitud,
      latitud_taxista: txInfo.latitud,
      nombre,
      telefono,
      direccion,
      latitud,
      longitud,
      direccion_fin,
      latitud_fin,
      longitud_fin,
      descripcion,
      hora_reserva,
      fecha_reserva,
      tipo
    });

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar el estado del viaje:', error);
    res.status(500).send('Error al actualizar el estado del viaje.');
  }
};

exports.getAcceptedRequests = async (req, res) => {
  const { id_usuario } = req.query;

  try {
    const acceptedRequests = await pool.query(
      `SELECT v.*, c.nombre, c.telefono 
       FROM viajes v 
       JOIN contactos c ON v.telefono_cliente = c.telefono 
       WHERE v.id_taxista = $1 AND v.estado NOT IN ('rechazado', 'finalizado', 'cancelado')`,
      [id_usuario]
    );

    res.json(acceptedRequests.rows);
  } catch (error) {
    console.error('Error al obtener los viajes aceptados:', error);
    res.status(500).send('Error al obtener los viajes aceptados');
  }
};

exports.getRequestByPhoneNumber = async (req, res) => {
  const { telefono_cliente, id_viaje } = req.query;

  try {
    const request = await pool.query(
      `SELECT v.*, c.nombre, c.telefono 
       FROM viajes v 
       JOIN contactos c ON v.telefono_cliente = c.telefono 
       WHERE v.id_viaje = $1 AND v.telefono_cliente = $2`,
      [id_viaje, telefono_cliente]
    );

    if (request.rows.length === 0) {
      return res.status(404).send('No se encontró ningún viaje con el ID y teléfono proporcionados');
    }

    res.json(request.rows[0]);
  } catch (error) {
    console.error('Error al obtener el viaje por ID y teléfono:', error);
    res.status(500).send('Error al obtener el viaje por ID y teléfono');
  }
};

exports.getPendingReservations = async (req, res) => {
  try {
    const pendingReservations = await pool.query(
      `SELECT v.id_viaje AS "viajeId", v.estado, v.latitud, v.longitud, v.latitud_fin, v.longitud_fin, 
              v.fecha_reserva, v.hora_reserva, v.descripcion, v.tipo, 
              c.telefono AS telefono_cliente, c.nombre AS name, 
              v.direccion AS address, v.direccion_fin AS "endAddress"
       FROM viajes v 
       JOIN contactos c ON v.telefono_cliente = c.telefono 
       WHERE v.estado = 'pendiente' AND v.tipo = 'reserva' AND v.fecha_reserva IS NOT NULL`
    );

    res.json(pendingReservations.rows);
  } catch (error) {
    console.error('Error al obtener las reservas pendientes:', error);
    res.status(500).send('Error al obtener las reservas pendientes');
  }
};

exports.getDriverInfoByTripId = async (req, res) => {
  const { id_viaje } = req.params;

  try {
    // Primero, obtenemos el ID del conductor usando el ID del viaje
    const tripResult = await pool.query('SELECT id_taxista FROM viajes WHERE id_viaje = $1', [id_viaje]);
    if (tripResult.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }
    const { id_taxista } = tripResult.rows[0];

    // Luego, obtenemos la información del conductor usando el ID del conductor
    const driverResult = await pool.query('SELECT nombre, telefono, placa, movil, navegacion FROM usuarios WHERE id_usuario = $1', [id_taxista]);
    if (driverResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    res.status(200).json(driverResult.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la información del conductor' });
  }
};

exports.getHistoryTrips = async (req, res) => {
  const { id_usuario } = req.params;
  console.log(`Consultando historial para usuario ${id_usuario}`);

  try {
    const query = 'SELECT * FROM viajes WHERE id_taxista = $1 ORDER BY fecha_hora_inicio DESC';
    const values = [id_usuario];

    console.log('Query:', query);
    console.log('Values:', values);

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener el historial de viajes:', error);
    res.status(500).json({ error: 'Error al obtener el historial de viajes' });
  }
};

exports.getHistoryTripsByPhone = async (req, res) => {
  const { telefono_cliente } = req.params;
  console.log(`Consultando historial para cliente con teléfono ${telefono_cliente}`);

  try {
    const query = 'SELECT * FROM viajes WHERE telefono_cliente = $1 ORDER BY fecha_hora_inicio DESC';
    const values = [telefono_cliente];

    console.log('Query:', query);
    console.log('Values:', values);

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener el historial de viajes:', error);
    res.status(500).json({ error: 'Error al obtener el historial de viajes' });
  }
};

exports.getHistoryAllTrips = async (req, res) => {
  try {
    const query = `
      SELECT v.*, u.nombre AS nombre_conductor
      FROM viajes v
      LEFT JOIN usuarios u ON v.id_taxista = u.id_usuario
      ORDER BY v.fecha_hora_inicio DESC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener el historial de todos los viajes:', error);
    res.status(500).json({ error: 'Error al obtener el historial de todos los viajes' });
  }
};

exports.getDrivers = async (req, res) => {
  try {
    const query = `
      SELECT id_usuario, nombre
      FROM usuarios
      WHERE tipo = 'tipo2'
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener la lista de conductores:', error);
    res.status(500).json({ error: 'Error al obtener la lista de conductores' });
  }
};

exports.getDriverInfo = async (req, res) => {
  const { id_usuario } = req.params;
  console.log(`obteniendo datos para ${id_usuario}`)
  try {
    const query = `
      SELECT nombre, telefono, placa, movil, navegacion
      FROM usuarios
      WHERE id_usuario = $1
    `;
    const values = [id_usuario];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener la información del conductor:', error);
    res.status(500).json({ error: 'Error al obtener la información del conductor' });
  }
};

exports.getTripInfo = async (req, res) => {
  const { id_viaje } = req.params;
  console.log(`Obteniendo datos para ${id_viaje}`);
  try {
    const query = `
      SELECT 
        v.id_viaje,
        v.telefono_cliente,
        v.id_taxista,
        v.estado,
        v.fecha_hora_inicio,
        v.fecha_hora_fin,
        v.direccion,
        v.latitud,
        v.longitud,
        v.direccion_fin,
        v.latitud_fin,
        v.longitud_fin,
        v.retry_count,
        v.tipo,
        v.descripcion,
        v.fecha_reserva,
        v.hora_reserva,
        c.nombre AS nombre_cliente,
        u.nombre AS nombre_taxista,
        u.telefono AS telefono_taxista,
        u.movil
      FROM 
        viajes v
      LEFT JOIN 
        contactos c ON v.telefono_cliente = c.telefono
      LEFT JOIN 
        usuarios u ON v.id_taxista = u.id_usuario
      WHERE 
        v.id_viaje = $1
    `;
    const values = [id_viaje];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener la información del viaje:', error);
    res.status(500).json({ error: 'Error al obtener la información del viaje' });
  }
};

exports.panic = async (req, res, io) => {
  const { id_usuario } = req.body;

  // Emitir el evento de pánico a todos los clientes conectados
  io.emit('panic_event', { id_usuario });

  res.status(200).send({ message: 'Panic event emitted' });
};


const haversineDistance = (coords1, coords2) => {
  const toRad = (x) => (x * Math.PI) / 180;
  const lat1 = coords1.latitude;
  const lon1 = coords1.longitude;
  const lat2 = coords2.latitude;
  const lon2 = coords2.longitude;

  const R = 6371; // Radio de la Tierra en km

  const x1 = lat2 - lat1;
  const dLat = toRad(x1);
  const x2 = lon2 - lon1;
  const dLon = toRad(x2);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distance = R * c;

  return distance;
};

exports.panic2 = async (req, res, io) => {
  const { latitude, longitude } = req.body;

  try {
    const nearbyTaxis = await findNearbyTaxis(latitude, longitude, 1000); 

    if (nearbyTaxis.length === 0) {
      return res.status(404).json({ message: 'No nearby users found' });
    }

    let nearestUser = null;
    let minDistance = Infinity;

    nearbyTaxis.forEach(user => {
      const userCoords = { latitude: user.latitud, longitude: user.longitud };
      const distance = haversineDistance({ latitude, longitude }, userCoords);
      console.log(`Distancia a ${user.id_usuario}: ${distance} km`);

      if (distance < minDistance) {
        nearestUser = user;
        minDistance = distance;
      }
    });

    if (!nearestUser) {
      return res.status(404).json({ message: 'No nearby users found' });
    }

    // Devolver el id_usuario del usuario más cercano
    res.status(200).json({ nearestUser: nearestUser.id_usuario });
  } catch (error) {
    console.error('Error finding nearest user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

