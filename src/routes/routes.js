const express = require('express');
const pool = require('../config/dbConfig');
const {
  processMessage,
  sendTextMessage,
  sendImageMessage,
  sendVideoMessage,
  sendDocumentMessage,
  sendAudioMessage
} = require('../handlers/repliesHandler');

// Función para obtener la URL del medio
function getMediaUrl(type, mediaUrl, latitude, longitude) {
  if (!mediaUrl) return null;
  const host = process.env.HOST || 'http://localhost:3001';
  switch (type) {
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker':
      return `${host}${mediaUrl}`;
    case 'location':
      return `https://maps.google.com/?q=${latitude},${longitude}`;
    default:
      return null;
  }
}

// Función para obtener la URL de la miniatura
function getThumbnailUrl(type, thumbnailUrl) {
  if (!thumbnailUrl) return null;
  const host = process.env.HOST || 'http://localhost:3001';
  switch (type) {
    case 'image':
    case 'audio':
    case 'video':
    case 'sticker':
      return `${host}${thumbnailUrl}`;
    default:
      return null;
  }
}

// Definimos la función que acepta 'io' como parámetro y devuelve el router configurado
const createRouter = (io) => {
  const router = express.Router();

  router.post('/new-message', async (req, res) => {
    const { senderId, messageData } = req.body;
    try {
      await processMessage(io, senderId, messageData);
      io.emit('new-message', { senderId, messageData }); // El servidor emite el evento
      console.log('Emitido yeees');
      res.status(200).send('Mensaje recibido y emitido');
    } catch (error) {
      console.error('Error processing message:', error);
      res.status(500).send('Hubo un error al procesar el mensaje');
    }
  });

  router.post('/reset-unread/:conversationId', async (req, res) => {
    const { conversationId } = req.params;
    try {
      const resetUnread = `UPDATE conversations SET unread_messages = 0 WHERE conversation_id = $1`;
      await pool.query(resetUnread, [conversationId]);
      res.send('Unread messages counter reset successfully.');
    } catch (error) {
      console.error('Error resetting unread messages:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  router.get('/conversations/:conversationId', async (req, res) => {
    const { conversationId } = req.params;
    console.log(`Solicitud de conversación con id ${conversationId}`);
    try {
      const query = `
        SELECT
          c.conversation_id,
          c.contact_id,
          c.state,
          c.last_update,
          c.unread_messages,
          c.id_usuario,
          ct.telefono,
          ct.nombre,
          ct.fecha_nacimiento,
          ct.genero,
          ct,link_foto,
          u.nombre as responsable_nombre,
          last_message_info.last_message,
          last_message_info.last_message_time,
          last_message_info.message_type
        FROM 
          conversations c
        LEFT JOIN usuarios u ON c.id_usuario = u.id_usuario
        LEFT JOIN contactos ct ON c.contact_id = ct.telefono
        LEFT JOIN LATERAL (
          SELECT
            sub.last_message,
            sub.last_message_time,
            sub.message_type
          FROM (
            SELECT
              message_text AS last_message,
              received_at AS last_message_time,
              message_type
            FROM messages
            WHERE conversation_fk = c.conversation_id
            UNION
            SELECT
              reply_text AS last_message,
              created_at AS last_message_time,
              reply_type AS message_type
            FROM replies
            WHERE conversation_fk = c.conversation_id
          ) sub
          ORDER BY sub.last_message_time DESC
          LIMIT 1
        ) last_message_info ON true
        WHERE c.conversation_id = $1;
      `;
      const { rows } = await pool.query(query, [conversationId]);
      if (rows.length > 0) {
        res.json(rows[0]);
      } else {
        res.status(404).send('Conversation not found');
      }
    } catch (err) {
      console.error('Error fetching conversation details:', err);
      res.status(500).send('Internal Server Error');
    }
  });

  router.get('/conversations', async (req, res) => {
    try {
      const query = `
        SELECT
          c.conversation_id,
          c.contact_id,
          ct.telefono,
          c.state,
          c.last_update,
          c.unread_messages,
          c.id_usuario,
          ct.nombre,
          ct.fecha_nacimiento,
          ct.genero,
          ct.link_foto,
          u.nombre as responsable_nombre,
          last_message_info.last_message,
          last_message_info.last_message_time,
          last_message_info.message_type
        FROM 
          conversations c
        LEFT JOIN usuarios u ON c.id_usuario = u.id_usuario
        LEFT JOIN contactos ct ON c.contact_id = ct.telefono
        LEFT JOIN LATERAL (
          SELECT
            sub.last_message,
            sub.last_message_time,
            sub.message_type
          FROM (
            SELECT
              message_text AS last_message,
              received_at AS last_message_time,
              message_type
            FROM messages
            WHERE conversation_fk = c.conversation_id
            UNION
            SELECT
              reply_text AS last_message,
              created_at AS last_message_time,
              reply_type AS message_type
            FROM replies
            WHERE conversation_fk = c.conversation_id
          ) sub
          ORDER BY sub.last_message_time DESC
          LIMIT 1
        ) last_message_info ON true
      `;
      const { rows } = await pool.query(query);
      res.json(rows);
    } catch (error) {
      console.error('Error fetching conversations:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  router.get('/messages/:id', async (req, res) => {
    const { id } = req.params;
    const { offset = 0 } = req.query; // offset indica desde qué mensaje empezar

    const query = `
      SELECT * FROM (
        SELECT 
          'message' as type, 
          id, 
          sender_id, 
          conversation_fk, 
          message_text as text, 
          message_media_url as media_url,
          file_name, 
          thumbnail_url,
          duration,
          latitude, 
          longitude, 
          received_at as timestamp,
          message_type,
          NULL as reply_header,
          NULL as reply_button,
          NULL as reply_type_header,
          reply_from,
          NULL as state
        FROM messages
        WHERE conversation_fk = $1
        UNION ALL
        SELECT 
          'reply' as type, 
          replies_id as id, 
          sender_id, 
          conversation_fk, 
          reply_text as text, 
          reply_media_url as media_url, 
          file_name,
          thumbnail_url,
          duration,
          latitude, 
          longitude, 
          created_at as timestamp,
          reply_type as message_type,
          reply_header,
          reply_button,
          reply_type_header,
          reply_from,
          state
        FROM replies
        WHERE conversation_fk = $1
      ) AS combined
      ORDER BY timestamp DESC
      OFFSET $2
      LIMIT 50;
    `;

    try {
      const result = await pool.query(query, [id, offset]);
      const messagesWithMedia = result.rows.map(row => ({
        ...row,
        url: getMediaUrl(row.message_type, row.media_url, row.latitude, row.longitude),
        thumbnail_url: getThumbnailUrl(row.message_type, row.thumbnail_url)
      }));
      res.json(messagesWithMedia);
    } catch (err) {
      console.error('Error fetching messages:', err);
      res.status(500).send('Internal Server Error');
    }
  });

  router.get('/contacts/:contactId', async (req, res) => {
    const { contactId } = req.params;
    try {
      const query = `
        SELECT
          telefono,
          nombre,
          fecha_nacimiento,
          genero,
          link_foto
        FROM contactos
        WHERE telefono = $1;
      `;
      const { rows } = await pool.query(query, [contactId]);
      if (rows.length > 0) {
        res.json(rows[0]);
      } else {
        res.status(404).send('Contact not found');
      }
    } catch (error) {
      console.error('Error fetching contact:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  return router;
};

module.exports = createRouter;
