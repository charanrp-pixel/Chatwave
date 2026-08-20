const { pool } = require('../db');

// Map userId → socketId for online presence
const onlineUsers = new Map();

function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    const userId = socket.handshake.auth.userId;

    if (!userId) {
      socket.disconnect();
      return;
    }

    console.log(`🔌 User ${userId} connected: ${socket.id}`);
    onlineUsers.set(userId, socket.id);

    // Mark user as online in DB
    pool.query('UPDATE users SET is_online = TRUE WHERE id = $1', [userId]).catch(console.error);

    // Notify all connected users of online status
    socket.broadcast.emit('user:online', { userId });

    // Join personal room for targeted messages
    socket.join(`user:${userId}`);

    // --- Send Message ---
    socket.on('message:send', async (data) => {
      const { conversationId, content } = data;
      if (!content || !content.trim() || !conversationId) return;

      try {
        // Verify sender is participant
        const conv = await pool.query(
          'SELECT * FROM conversations WHERE id = $1 AND (participant1_id = $2 OR participant2_id = $2)',
          [conversationId, userId]
        );
        if (conv.rows.length === 0) return;

        const conversation = conv.rows[0];
        const receiverId = conversation.participant1_id === parseInt(userId)
          ? conversation.participant2_id
          : conversation.participant1_id;

        // Insert message
        const result = await pool.query(
          `INSERT INTO messages (conversation_id, sender_id, content)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [conversationId, userId, content.trim()]
        );
        const message = result.rows[0];

        // Update conversation timestamp
        await pool.query(
          'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
          [conversationId]
        );

        // Get sender info
        const senderResult = await pool.query(
          'SELECT username, avatar_url FROM users WHERE id = $1',
          [userId]
        );
        const sender = senderResult.rows[0];

        const messagePayload = {
          ...message,
          sender_username: sender.username,
          sender_avatar: sender.avatar_url,
        };

        // Send to sender (confirmation)
        socket.emit('message:new', { conversationId, message: messagePayload });

        // Send to receiver if online
        io.to(`user:${receiverId}`).emit('message:new', {
          conversationId,
          message: messagePayload
        });

      } catch (err) {
        console.error('Error sending message:', err);
        socket.emit('message:error', { error: 'Failed to send message' });
      }
    });

    // --- Typing Indicators ---
    socket.on('typing:start', ({ conversationId, receiverId }) => {
      io.to(`user:${receiverId}`).emit('typing:start', { conversationId, userId });
    });

    socket.on('typing:stop', ({ conversationId, receiverId }) => {
      io.to(`user:${receiverId}`).emit('typing:stop', { conversationId, userId });
    });

    // --- Mark Messages as Read ---
    socket.on('messages:read', async ({ conversationId, senderId }) => {
      try {
        await pool.query(
          `UPDATE messages SET is_read = TRUE
           WHERE conversation_id = $1 AND sender_id = $2 AND is_read = FALSE`,
          [conversationId, senderId]
        );

        // Notify sender that messages were read
        io.to(`user:${senderId}`).emit('messages:read', { conversationId });
      } catch (err) {
        console.error('Error marking messages as read:', err);
      }
    });

    // --- Disconnect ---
    socket.on('disconnect', async () => {
      console.log(`🔌 User ${userId} disconnected`);
      onlineUsers.delete(userId);

      try {
        await pool.query(
          'UPDATE users SET is_online = FALSE, last_seen = NOW() WHERE id = $1',
          [userId]
        );
        socket.broadcast.emit('user:offline', { userId });
      } catch (err) {
        console.error('Error updating offline status:', err);
      }
    });
  });
}

module.exports = { setupSocketHandlers };
