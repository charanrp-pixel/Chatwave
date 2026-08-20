const { pool } = require('../db');

const onlineUsers = new Map();

function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    const userId = socket.handshake.auth.userId;
    if (!userId) { socket.disconnect(); return; }

    console.log(`🔌 User ${userId} connected: ${socket.id}`);
    onlineUsers.set(userId, socket.id);
    pool.query('UPDATE users SET is_online = TRUE WHERE id = $1', [userId]).catch(console.error);
    socket.broadcast.emit('user:online', { userId });
    socket.join(`user:${userId}`);

    // Auto-join all group rooms
    pool.query(
      'SELECT group_id FROM group_members WHERE user_id = $1',
      [userId]
    ).then(result => {
      result.rows.forEach(row => socket.join(`group:${row.group_id}`));
    }).catch(console.error);

    // ─── Direct Message ───────────────────────────────────────────────────────
    socket.on('message:send', async (data) => {
      const { conversationId, content } = data;
      if (!content || !content.trim() || !conversationId) return;

      try {
        const conv = await pool.query(
          'SELECT * FROM conversations WHERE id = $1 AND (participant1_id = $2 OR participant2_id = $2)',
          [conversationId, userId]
        );
        if (conv.rows.length === 0) return;

        const conversation = conv.rows[0];
        const receiverId = conversation.participant1_id === parseInt(userId)
          ? conversation.participant2_id
          : conversation.participant1_id;

        const result = await pool.query(
          `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *`,
          [conversationId, userId, content.trim()]
        );
        const message = result.rows[0];

        await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversationId]);

        const senderResult = await pool.query(
          'SELECT username, display_name, avatar_url FROM users WHERE id = $1', [userId]
        );
        const sender = senderResult.rows[0];

        const payload = { ...message, sender_username: sender.username, sender_display_name: sender.display_name, sender_avatar: sender.avatar_url };

        socket.emit('message:new', { conversationId, message: payload });
        io.to(`user:${receiverId}`).emit('message:new', { conversationId, message: payload });
      } catch (err) {
        console.error('DM send error:', err);
        socket.emit('message:error', { error: 'Failed to send message' });
      }
    });

    // ─── Group Message ────────────────────────────────────────────────────────
    socket.on('group:message', async ({ groupId, content }) => {
      if (!content || !content.trim() || !groupId) return;

      try {
        const memberCheck = await pool.query(
          'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
          [groupId, userId]
        );
        if (memberCheck.rows.length === 0) return;

        const result = await pool.query(
          'INSERT INTO group_messages (group_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *',
          [groupId, userId, content.trim()]
        );

        const senderResult = await pool.query(
          'SELECT username, display_name, avatar_url FROM users WHERE id = $1', [userId]
        );
        const sender = senderResult.rows[0];

        const payload = {
          ...result.rows[0],
          sender_username: sender.username,
          sender_display_name: sender.display_name,
          sender_avatar: sender.avatar_url,
        };

        io.to(`group:${groupId}`).emit('group:message', { groupId, message: payload });
      } catch (err) {
        console.error('Group message error:', err);
      }
    });

    // ─── Join Group Room ──────────────────────────────────────────────────────
    socket.on('group:join', async (groupId) => {
      try {
        const check = await pool.query(
          'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
          [groupId, userId]
        );
        if (check.rows.length > 0) socket.join(`group:${groupId}`);
      } catch (err) {
        console.error('Group join error:', err);
      }
    });

    // ─── Typing ───────────────────────────────────────────────────────────────
    socket.on('typing:start', ({ conversationId, receiverId }) => {
      io.to(`user:${receiverId}`).emit('typing:start', { conversationId, userId });
    });
    socket.on('typing:stop', ({ conversationId, receiverId }) => {
      io.to(`user:${receiverId}`).emit('typing:stop', { conversationId, userId });
    });
    socket.on('group:typing:start', ({ groupId }) => {
      socket.to(`group:${groupId}`).emit('group:typing:start', { groupId, userId });
    });
    socket.on('group:typing:stop', ({ groupId }) => {
      socket.to(`group:${groupId}`).emit('group:typing:stop', { groupId, userId });
    });

    // ─── Read Receipts ────────────────────────────────────────────────────────
    socket.on('messages:read', async ({ conversationId, senderId }) => {
      try {
        await pool.query(
          'UPDATE messages SET is_read = TRUE WHERE conversation_id = $1 AND sender_id = $2 AND is_read = FALSE',
          [conversationId, senderId]
        );
        io.to(`user:${senderId}`).emit('messages:read', { conversationId });
      } catch (err) {
        console.error('Read receipt error:', err);
      }
    });

    // ─── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`🔌 User ${userId} disconnected`);
      onlineUsers.delete(userId);
      try {
        await pool.query('UPDATE users SET is_online = FALSE, last_seen = NOW() WHERE id = $1', [userId]);
        socket.broadcast.emit('user:offline', { userId });
      } catch (err) {
        console.error('Disconnect error:', err);
      }
    });
  });
}

module.exports = { setupSocketHandlers };
