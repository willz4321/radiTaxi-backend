const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pool = require('../config/dbConfig');
const { fileURLToPath } = require('url');
const { dirname } = require('path');
const { processConversation } = require('./chatbot');
const ffmpeg = require('fluent-ffmpeg');

// Function to process received messages of different types
async function processMessage(io, senderId, messageData, oldMessage) {
  console.log('Processing message from sender:', senderId);
  console.log('Message data:', messageData);

  // Get or create the conversation
  const conversationId = await getOrCreateConversation(senderId);

  // Check the time of the last message
  const lastMessageQuery = `
    SELECT received_at FROM messages
    WHERE conversation_fk = $1
    ORDER BY received_at DESC
    LIMIT 1;
  `;
  const lastMessageRes = await pool.query(lastMessageQuery, [conversationId]);

  if (lastMessageRes.rows.length > 0) {
    const lastMessageTime = new Date(lastMessageRes.rows[0].received_at);
    const currentTime = new Date();
    const timeDifference = (currentTime - lastMessageTime) / (1000 * 60); // Difference in minutes

    if (timeDifference > 2) {
      // Update the state of the conversation
      await updateConversationState(conversationId, 'new');
    }
  }

  const incrementUnread = `UPDATE conversations SET unread_messages = unread_messages + 1 WHERE conversation_id = $1`;
  await pool.query(incrementUnread, [conversationId]);

  // Get the number of unread messages
  const unreadRes = await pool.query('SELECT unread_messages FROM conversations WHERE conversation_id = $1', [conversationId]);
  const unreadMessages = unreadRes.rows[0].unread_messages;

  let mediaUrl = null;
  let messageText = messageData.text || null; 
  let replyFrom = messageData.context?.from || null;

  if (messageData.type === 'image' || messageData.type === 'audio' || messageData.type === 'video' || messageData.type === 'document' || messageData.type === 'sticker') {
    const mediaType = messageData.type;
    const mediaData = messageData[mediaType];
    if (mediaData && mediaData.id && mediaData.mime_type) {
      mediaUrl = await downloadMedia(mediaData.id, mediaData.mime_type);
      if ((mediaType === 'image' || mediaType === 'video' || mediaType === 'document') && mediaData.caption) {
        messageText = mediaData.caption; // Set message text to image, video, or document caption if available
      }
    }
  } 

  console.log('Reply from ID:', replyFrom);

  let thumbnailUrl = null;
  let mediaDuration = null;

  if ((messageData.type === 'video' || messageData.type === 'audio') && mediaUrl) {
    const mediaPath = path.join(__dirname, '..', '..', 'public', mediaUrl);
    if (fs.existsSync(mediaPath)) {
      try {
        mediaDuration = await getVideoDurationInSeconds(mediaPath);
        // If it's a video, create a thumbnail
        if (messageData.type === 'video') {
          const thumbnailPath = await createThumbnail(mediaPath);
          thumbnailUrl = thumbnailPath.replace('public', '');
        }
      } catch (err) {
        console.error('Error getting media duration or generating thumbnail:', err);
      }
    }
  }

  const insertQuery = `
    INSERT INTO messages (
      id,
      sender_id,
      conversation_fk, 
      message_type, 
      message_text, 
      message_media_url, 
      thumbnail_url,
      duration,
      latitude, 
      longitude,
      file_name,
      reply_from
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *;
  `;

  const values = [
    messageData.id,  // Add the message ID here
    senderId,
    conversationId,
    messageData.type,
    messageText,
    mediaUrl,
    thumbnailUrl,     // URL of the thumbnail for videos
    mediaDuration,    // Duration of the audio or video
    messageData.latitude || null,
    messageData.longitude || null,
    messageData.file_name || null,
    replyFrom
  ];
  const state = await getConversationState(conversationId);

  if (oldMessage == "no") {
    try {
      const res = await pool.query(insertQuery, values);
      console.log('Inserted message with conversation ID:', conversationId, 'Message details:', res.rows[0]);
      const newMessage = res.rows[0];

      // Emit the processed message to clients
      io.emit('newMessage', {
        id: newMessage.id,
        conversationId: conversationId,
        timestamp: newMessage.received_at,
        senderId: senderId,
        message_type: messageData.type,
        text: newMessage.message_text,
        url: newMessage.message_media_url,
        thumbnail_url: newMessage.thumbnail_url,
        duration: mediaDuration,
        latitude: messageData.latitude || null,
        longitude: messageData.longitude || null,
        type: 'message',
        unread_messages: unreadMessages,
        file_name: messageData.file_name,
        reply_from: newMessage.reply_from,
        state: newMessage.state
      });

      console.log('Message emitted:', newMessage.id);
    } catch (error) {
      console.error('Error inserting message into database:', error);
    }
  }

  await processConversation(io, senderId, messageData, conversationId, state);
}

// Function to update the state of a conversation
async function updateConversationState(conversationId, newState) {
  const query = 'UPDATE conversations SET state = $2 WHERE conversation_id = $1';
  try {
    await pool.query(query, [conversationId, newState]);
  } catch (error) {
    console.error('Database error updating conversation state:', error);
    throw error;
  }
}

const getVideoDurationInSeconds = (videoPath) => new Promise((resolve, reject) => {
  ffmpeg.ffprobe(videoPath, (err, metadata) => {
    if (err) {
      reject(err);
    } else {
      resolve(metadata.format.duration);
    }
  });
});

const createThumbnail = (videoPath) => new Promise((resolve, reject) => {
  const thumbnailFilename = `thumbnail-${path.basename(videoPath, path.extname(videoPath))}.png`;
  const thumbnailDir = path.join(__dirname, '..', '..', 'public', 'thumbnail');

  if (!fs.existsSync(thumbnailDir)) {
    fs.mkdirSync(thumbnailDir, { recursive: true });
  }

  const thumbnailPath = path.join(thumbnailDir, thumbnailFilename);

  ffmpeg(videoPath)
    .on('end', () => resolve(`/thumbnail/${thumbnailFilename}`))
    .on('error', (err) => reject(err))
    .output(thumbnailPath)
    .outputOptions([
      '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=290:290', // Crop to square then scale
      '-frames:v', '1' // Only output one frame
    ])
    .run();
});

// Function to download and save any type of media file
async function downloadMedia(mediaId, mimeType) {
  console.log('Media ID received for download:', mediaId);
  const getUrl = `https://graph.facebook.com/v19.0/${mediaId}`;

  try {
    // Get the media URL
    const getUrlResponse = await axios.get(getUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
      },
    });

    const mediaUrl = getUrlResponse.data.url;
    if (!mediaUrl) {
      console.error('Media URL not found in response:', getUrlResponse.data);
      return null;
    }

    // Download the media file
    const mediaResponse = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
      },
    });

    // Determine the file extension based on the MIME type
    const extension = mimeType.split('/')[1];

    // Determine the directory based on the MIME type
    let mediaDir;
    switch (mimeType.split('/')[0]) {
      case 'image':
        mediaDir = path.join(__dirname, '..', '..', 'public', 'media', 'images');
        break;
      case 'audio':
        mediaDir = path.join(__dirname, '..', '..', 'public', 'media', 'audios');
        break;
      case 'video':
        mediaDir = path.join(__dirname, '..', '..', 'public', 'media', 'videos');
        break;
      case 'application':
        mediaDir = path.join(__dirname, '..', '..', 'public', 'media', 'documents');
        break;
      default:
        mediaDir = path.join(__dirname, '..', '..', 'public', 'media', 'documents');
        break;
    }

    if (!fs.existsSync(mediaDir)) {
      fs.mkdirSync(mediaDir, { recursive: true });
    }

    // Save the media file
    const mediaPath = path.join(mediaDir, `${mediaId}.${extension}`);
    fs.writeFileSync(mediaPath, mediaResponse.data);
    console.log('Media stored at:', mediaPath);

    // URL to access the file from the server
    const mediaServerUrl = `/media/${mimeType.split('/')[0] === 'application' ? 'documents' : mimeType.split('/')[0] + 's'}/${mediaId}.${extension}`;
    return mediaServerUrl;
  } catch (error) {
    console.error('Failed to download media. Error:', error.message);
    return null;
  }
}

// Utility function to get or create a conversation
async function getOrCreateConversation(phoneNumber) {
  const findQuery = 'SELECT conversation_id FROM conversations WHERE contact_id = $1';
  try {
    let result = await pool.query(findQuery, [phoneNumber]);
    if (result.rows.length > 0) {
      return result.rows[0].conversation_id; // Return the ID if the conversation exists
    } else {
      // Create a new contact
      const contactQuery = 'INSERT INTO contactos (telefono) VALUES ($1) RETURNING telefono';
      const contactResult = await pool.query(contactQuery, [phoneNumber]);
      const contactId = contactResult.rows[0].telefono; // Obtén el ID del contacto recién insertado

      console.log(`ID del contacto: ${contactId}`);

      // Create a new conversation if it doesn't exist
      const insertQuery = 'INSERT INTO conversations (contact_id, state) VALUES ($1, $2) RETURNING conversation_id';
      const conversationResult = await pool.query(insertQuery, [contactId, 'new']); // Utiliza contactId como un valor numérico
      const conversationId = conversationResult.rows[0].conversation_id;

      return conversationId; // Return the new conversation ID
    }
  } catch (err) {
    console.error('Database error in getOrCreateConversation:', err);
    throw err;
  }
}

async function getConversationState(conversationId) {
  const query = 'SELECT state FROM conversations WHERE conversation_id = $1';
  try {
    const result = await pool.query(query, [conversationId]);
    if (result.rows.length > 0) {
      return result.rows[0].state;
    } else {
      // If the conversation is not found, consider an initial state
      return 'new';
    }
  } catch (error) {
    console.error('Database error getting conversation state:', error);
    throw error;
  }
}

module.exports = { processMessage, updateConversationState };
