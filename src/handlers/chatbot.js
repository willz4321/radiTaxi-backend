const axios = require('axios');
const pool = require('../config/dbConfig.js');

// Token y número de teléfono desde las variables de entorno
const token = process.env.WHATSAPP_API_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

// Función para obtener la respuesta de GPT-4
async function obtenerRespuestaGPT(prompt) {
  const apiKey = process.env.OPENAI_API_KEY; 
  const url = "https://api.openai.com/v1/chat/completions";

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  const payload = {
    model: "gpt-4",
    messages: [
      { role: "system", content: "Eres Rebeca, la asistente virtual de Radio Taxi Ipiales, una empresa de solicitud de taxis, domicilios y reserva de viajes en la ciudad de Ipiales, Nariño, Colombia, entiendes a la perfección las expresiones típicas de la región y el norte del Ecuador, eres una mujer de 28 años experta en atención al cliente, usas un lenguaje formal y al mismo tiempo fresco y amigable." },
      { role: "user", content: prompt }
    ]
  };

  try {
    const response = await axios.post(url, payload, { headers });
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error al obtener respuesta de GPT-4:", error);
    return "Error al obtener la respuesta";
  }
}

// Función para enviar un mensaje de WhatsApp y registrar el mensaje en la base de datos
async function sendWhatsAppMessage(io, phone, messageText, conversationId) {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: messageText }
  };

  // Obtén la cantidad de mensajes no leídos y el id_usuario responsable
  const unreadRes = await pool.query('SELECT unread_messages, id_usuario FROM conversations WHERE conversation_id = $1', [conversationId]);
  const unreadMessages = unreadRes.rows[0].unread_messages;
  const responsibleUserId = unreadRes.rows[0].id_usuario;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('WhatsApp message sent:', response.data);
    const whatsappMessageId = response.data.messages[0].id;

    // Intenta insertar en la base de datos
    const insertQuery = `
      INSERT INTO replies (
        replies_id,
        sender_id,
        conversation_fk,
        reply_type,
        reply_text,
        reply_media_url,
        latitude,
        longitude
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;
    `;
    const messageValues = [
      whatsappMessageId,
      phone,           
      conversationId,
      'text',
      messageText,
      null,
      null,
      null
    ];
    const res = await pool.query(insertQuery, messageValues);
    console.log('Inserted reply ID:', res.rows[0]);
    const newMessage = res.rows[0];
    // Emitir el mensaje procesado a los clientes suscritos a esa conversación
    io.emit('newMessage', {
      id: newMessage.replies_id,
      conversationId: conversationId,
      timestamp: newMessage.created_at,
      senderId: phone,
      message_type: 'text',
      text: messageText || null,
      mediaUrl: null,
      thumbnailUrl: null,
      duration: null,
      latitude: null,
      longitude: null,
      type: 'reply',
      unread_messages: unreadMessages,
      responsibleUserId: responsibleUserId
    });
    console.log('Mensaje emitido:', newMessage.replies_id);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message || error);
  }
}

// Función para enviar una imagen por WhatsApp
async function sendWhatsAppMessageImage(io, phone, imageUrl, conversationId) {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "image",
    image: { link: imageUrl }
  };

  // Obtén la cantidad de mensajes no leídos y el id_usuario responsable
  const unreadRes = await pool.query('SELECT unread_messages, id_usuario FROM conversations WHERE conversation_id = $1', [conversationId]);
  const unreadMessages = unreadRes.rows[0].unread_messages;
  const responsibleUserId = unreadRes.rows[0].id_usuario;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(response.data);

    // Intenta insertar en la base de datos
    const insertQuery = `
      INSERT INTO replies (
        replies_id,
        sender_id,
        conversation_fk,
        reply_type,
        reply_text,
        reply_media_url,
        latitude,
        longitude
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;
    `;
    const messageValues = [
      response.data.messages[0].id,
      phone,           
      conversationId,
      'image',
      null,
      imageUrl,
      null,
      null
    ];
    const res = await pool.query(insertQuery, messageValues);
    console.log('Inserted reply ID:', res.rows[0]);
    const newMessage = res.rows[0];
    // Emitir el mensaje procesado a los clientes suscritos a esa conversación
    io.emit('newMessage', {
      id: newMessage.replies_id,
      conversationId: conversationId,
      timestamp: newMessage.created_at,
      senderId: phone,
      type: 'image',
      text: null,
      mediaUrl: imageUrl,
      thumbnailUrl: null,
      duration: null,
      latitude: null,
      longitude: null,
      type: 'reply',
      unread_messages: unreadMessages,
      responsibleUserId: responsibleUserId
    });
    console.log('Mensaje emitido:', newMessage.replies_id);

  } catch (error) {
    console.error('Error sending WhatsApp image:', error.response?.data || error.message);
  }
}

// Función para enviar una ubicación por WhatsApp
async function sendWhatsAppLocation(io, phone, lat, lng, conversationId) {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "location",
    location: {
      longitude: lng,
      latitude: lat
    }
  };

  // Obtén la cantidad de mensajes no leídos y el id_usuario responsable
  const unreadRes = await pool.query('SELECT unread_messages, id_usuario FROM conversations WHERE conversation_id = $1', [conversationId]);
  const unreadMessages = unreadRes.rows[0].unread_messages;
  const responsibleUserId = unreadRes.rows[0].id_usuario;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(response.data);

    // Intenta insertar en la base de datos
    const insertQuery = `
      INSERT INTO replies (
        replies_id,
        sender_id,
        conversation_fk,
        reply_type,
        reply_text,
        reply_media_url,
        latitude,
        longitude
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;
    `;
    const messageValues = [
      response.data.messages[0].id,
      phone,           
      conversationId,
      'location',
      null,
      null,
      lat,
      lng
    ];
    const res = await pool.query(insertQuery, messageValues);
    console.log('Inserted reply ID:', res.rows[0].replies_id);
    const newMessage = res.rows[0];
    // Emitir el mensaje procesado a los clientes suscritos a esa conversación
    io.emit('newMessage', {
      id: newMessage.replies_id,
      conversationId: conversationId,
      timestamp: newMessage.created_at,
      senderId: phone,
      type: 'location',
      text: null,
      mediaUrl: null,
      thumbnailUrl: null,
      duration: null,
      latitude: lat,
      longitude: lng,
      type: 'reply',
      unread_messages: unreadMessages,
      responsibleUserId: responsibleUserId
    });
    console.log('Mensaje emitido:', newMessage.replies_id);

  } catch (error) {
    console.error('Error sending WhatsApp location:', error.response?.data || error.message);
  }
}

async function updateConversationState(conversationId, newState) {
  const query = 'UPDATE conversations SET state = $2 WHERE conversation_id = $1';
  try {
      await pool.query(query, [conversationId, newState]);
  } catch (error) {
      console.error('Database error updating conversation state:', error);
      throw error;
  }
}


async function getReverseGeocoding(latitude, longitude) {
  try {
    const api = process.env.GOOGLE_MAPS_API_KEY
    const response = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${api}`);
    console.log(api);
    console.log(response);
    const data = response.data;

    if (data.status !== 'OK' || !data.results[0]) {
      console.error('Geocoding error:', data.status);
      return null;
    }

    const addressComponents = data.results[0].address_components;
    const road = addressComponents.find(comp => comp.types.includes('route'))?.long_name;
    const house_number = addressComponents.find(comp => comp.types.includes('street_number'))?.long_name;
    const city = addressComponents.find(comp => comp.types.includes('locality'))?.long_name;
    const state = addressComponents.find(comp => comp.types.includes('administrative_area_level_1'))?.long_name;

    // Construye la dirección en el formato deseado
    let formattedAddress = `${road || ''} #${house_number || ''} ${city || ''}, ${state || ''}`;
    formattedAddress = formattedAddress.replace(/\s{2,}/g, ' ').replace(/^,\s*|,\s*$/g, '');

    return formattedAddress;
  } catch (error) {
    console.error('Error during reverse geocoding:', error.response.data || error.message);
    return null;
}
}

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

async function processConversation(io, senderId, message, conversationId, currentState) {
  let responseText;
  let responseImage;
  const messageText = message.text ? message.text.toLowerCase() : "";
  switch (currentState) {
    case 'new':
      responseText = await obtenerRespuestaGPT("Responde amablemente al cliente siguiendo este modelo 'Hola, Soy Rebeca, Asistente virtual de Radio Taxi Ipiales, te puedo ayudar a gestionar tu solicitud de taxi, domicilio o reserva de viajes, ¿En que te gustaría que te ayude?' solo quiero que respondas");
      await sendWhatsAppMessage(io, senderId, responseText, conversationId);
      await updateConversationState(conversationId, 'awaiting_response');
      break;
    
    case 'awaiting_response':
      const interpreteGPT = await obtenerRespuestaGPT(`Según la respuesta del cliente responde 1 si quiere un Taxi, 2 si quiere un domicilio, 3 si quiere reservar un viaje o responde NA si no es ninguna de las anteriores o no entiendes la respuesta. Respuesta cliente: ${message.text}`);
      if (interpreteGPT === '1') {
        responseText = await obtenerRespuestaGPT("Genera una respuesta siguiendo esta estructura 'Comparte la dirección exacta donde deseas ser recogido o tu ubicación para continuar con la solicitud. A continuación encuentras una imagen instructiva para compartir tu ubicación.'");
        await sendWhatsAppMessage(io, senderId, responseText, conversationId);
        responseImage = "https://i.blogs.es/d0529e/compartir-ubicacion/1366_2000.jpg";
        await sendWhatsAppMessageImage(io, senderId, responseImage, conversationId);
        await updateConversationState(conversationId, 'awaiting_location');
      } else if (interpreteGPT === '2') {
        // Similar a la lógica anterior, adaptar para 'domicilio'
        await sendWhatsAppMessage(io, senderId, responseText, conversationId);
        responseImage = "https://i.blogs.es/d0529e/compartir-ubicacion/1366_2000.jpg";
        await sendWhatsAppMessageImage(io, senderId, responseImage, conversationId);
        await updateConversationState(conversationId, 'awaiting_location_delivery');
      } else if (interpreteGPT === '3') {
        // Lógica para reservar un viaje
        responseText = await obtenerRespuestaGPT("Genera una respuesta siguiendo esta estructura 'Por favor, proporciona la fecha y hora para reservar tu viaje en taxi.'");
        await sendWhatsAppMessage(io, senderId, responseText, conversationId);
        await updateConversationState(conversationId, 'awaiting_initial_location');
      } else {
        // Lógica para respuestas no entendidas
        responseText = await obtenerRespuestaGPT("Genera una respuesta natural siguiendo esta estructura 'No entendí tu respuesta. Por favor dime que servicio deseas solicitar: Taxi, Domicilio, Reserva de viaje'");
        await sendWhatsAppMessage(io, senderId, responseText, conversationId);
      }
      break;

    case 'awaiting_location':
      console.log(message.type);
      if (message.type === 'location') {
        const address = await getReverseGeocoding(message.latitude, message.longitude);
        if (address) {
          responseText = `Confirmas que tu ubicación es ${address}? Si es correcto, responde 'Sí'. Si no, responde 'No' y escribe la dirección correcta.`;
          await sendWhatsAppMessage(io, senderId, responseText, conversationId);
          await updateConversationState(conversationId, 'confirming_address');
        } else {
          responseText = "No pudimos convertir tus coordenadas en una dirección válida. Por favor, intenta nuevamente.";
          await sendWhatsAppMessage(io, senderId, responseText, conversationId);
        }
      } else {
        const location = await getGeocoding(message.text);
        console.log(location);
        responseText = `Confirmas que la ubicación coincide con la dirección que nos proporsionaste? Si es correcto, responde 'Sí'. Si no, intenta compartiendo tu ubicación siguiendo el instructivo que te compartí anteriormente.`;
        await sendWhatsAppMessage(io, senderId, responseText, conversationId);
        await sendWhatsAppLocation(io, senderId, location.latitude, location.longitude, conversationId);
      }
      break;

    case 'confirming_address':
      if (message.text.toLowerCase() === 'sí') {
        responseText = "Gracias por confirmar tu ubicación. Estamos procesando tu solicitud de taxi.";
        await updateConversationState(conversationId, 'processing_taxi_request');
      } else {
        responseText = "Por favor, escribe la dirección correcta donde estás ubicado.";
        await updateConversationState(conversationId, 'awaiting_correct_address');
      }
      await sendWhatsAppMessage(io, senderId, responseText, conversationId);
      break;

    case 'awaiting_correct_address':
      responseText = `Gracias por proporcionar tu dirección: ${message.text}. Estamos procesando tu solicitud de taxi.`;
      await updateConversationState(conversationId, 'processing_taxi_request');
      await sendWhatsAppMessage(io, senderId, responseText, conversationId);
      break;
    
    default:
      responseText = "No se ha reconocido el estado actual de la conversación.";
      await sendWhatsAppMessage(io, senderId, responseText, conversationId);
      break;
  }
}

module.exports = { processConversation, obtenerRespuestaGPT, sendWhatsAppMessage, sendWhatsAppMessageImage, sendWhatsAppLocation, updateConversationState, getReverseGeocoding, getGeocoding };
