const express = require('express');
const { pool } = require('../db');
const { isAuthenticated } = require('../middleware/auth');
const router = express.Router();

// Get all conversations for the current user
router.get('/conversations', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        c.id,
        c.last_message_at,
        CASE
          WHEN c.participant1_id = $1 THEN u2.id
          ELSE u1.id
        END AS other_user_id,
        CASE
          WHEN c.participant1_id = $1 THEN u2.username
          ELSE u1.username
        END AS other_username,
        CASE
          WHEN c.participant1_id = $1 THEN u2.display_name
          ELSE u1.display_name
        END AS other_display_name,
        CASE
          WHEN c.participant1_id = $1 THEN u2.avatar_url
          ELSE u1.avatar_url
        END AS other_avatar_url,
        CASE
          WHEN c.participant1_id = $1 THEN u2.is_online
          ELSE u1.is_online
        END AS other_is_online,
        (
          SELECT content FROM messages
          WHERE conversation_id = c.id
          ORDER BY created_at DESC LIMIT 1
        ) AS last_message,
        (
          SELECT COUNT(*) FROM messages
          WHERE conversation_id = c.id
            AND sender_id != $1
            AND is_read = FALSE
        ) AS unread_count
      FROM conversations c
      JOIN users u1 ON u1.id = c.participant1_id
      JOIN users u2 ON u2.id = c.participant2_id
      WHERE c.participant1_id = $1 OR c.participant2_id = $1
      ORDER BY c.last_message_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get or create a conversation with another user
router.post('/conversations', isAuthenticated, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const currentId = req.user.id;
  const otherId = parseInt(userId);

  if (currentId === otherId) return res.status(400).json({ error: 'Cannot chat with yourself' });

  const p1 = Math.min(currentId, otherId);
  const p2 = Math.max(currentId, otherId);

  try {
    // Try to find existing conversation
    let result = await pool.query(
      'SELECT * FROM conversations WHERE participant1_id = $1 AND participant2_id = $2',
      [p1, p2]
    );

    if (result.rows.length === 0) {
      result = await pool.query(
        'INSERT INTO conversations (participant1_id, participant2_id) VALUES ($1, $2) RETURNING *',
        [p1, p2]
      );
    }

    res.json({ conversation: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get messages in a conversation
router.get('/conversations/:id/messages', isAuthenticated, async (req, res) => {
  const conversationId = parseInt(req.params.id);

  try {
    // Verify user is a participant
    const conv = await pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND (participant1_id = $2 OR participant2_id = $2)',
      [conversationId, req.user.id]
    );
    if (conv.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });

    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT m.id, m.content, m.sender_id, m.is_read, m.created_at,
              u.username AS sender_username, u.avatar_url AS sender_avatar
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset]
    );

    // Mark messages as read
    await pool.query(
      `UPDATE messages SET is_read = TRUE
       WHERE conversation_id = $1 AND sender_id != $2 AND is_read = FALSE`,
      [conversationId, req.user.id]
    );

    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
