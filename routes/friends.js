const express = require('express');
const { pool } = require('../db');
const { isAuthenticated } = require('../middleware/auth');
const router = express.Router();

// Get all friends and pending requests
router.get('/', isAuthenticated, async (req, res) => {
  const userId = req.user.id;
  try {
    // Get accepted friends
    const friendsResult = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, u.last_seen
      FROM friend_requests fr
      JOIN users u ON (u.id = fr.sender_id OR u.id = fr.receiver_id)
      WHERE (fr.sender_id = $1 OR fr.receiver_id = $1)
        AND fr.status = 'accepted'
        AND u.id != $1
      ORDER BY u.is_online DESC, u.display_name ASC
    `, [userId]);

    // Get pending incoming requests
    const pendingResult = await pool.query(`
      SELECT fr.id as request_id, u.id as sender_id, u.username, u.display_name, u.avatar_url
      FROM friend_requests fr
      JOIN users u ON u.id = fr.sender_id
      WHERE fr.receiver_id = $1 AND fr.status = 'pending'
      ORDER BY fr.created_at DESC
    `, [userId]);

    res.json({
      friends: friendsResult.rows,
      pending: pendingResult.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send a friend request
router.post('/request', isAuthenticated, async (req, res) => {
  const { username } = req.body;
  const senderId = req.user.id;

  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (username.toLowerCase() === req.user.username.toLowerCase()) {
    return res.status(400).json({ error: 'Cannot send request to yourself' });
  }

  try {
    // Find user by username
    const userRes = await pool.query('SELECT id FROM users WHERE username ILIKE $1', [username]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const receiverId = userRes.rows[0].id;

    // Check if a request or friendship already exists
    const existing = await pool.query(`
      SELECT status FROM friend_requests
      WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
    `, [senderId, receiverId]);

    if (existing.rows.length > 0) {
      const status = existing.rows[0].status;
      if (status === 'accepted') return res.status(400).json({ error: 'Already friends' });
      return res.status(400).json({ error: 'Friend request already exists' });
    }

    await pool.query(`
      INSERT INTO friend_requests (sender_id, receiver_id, status)
      VALUES ($1, $2, 'pending')
    `, [senderId, receiverId]);

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${receiverId}`).emit('friend:request_received');
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Accept a friend request
router.put('/accept/:id', isAuthenticated, async (req, res) => {
  const requestId = parseInt(req.params.id);
  const userId = req.user.id;

  try {
    const result = await pool.query(`
      UPDATE friend_requests
      SET status = 'accepted', updated_at = NOW()
      WHERE id = $1 AND receiver_id = $2 AND status = 'pending'
      RETURNING *
    `, [requestId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or already accepted' });
    }

    const updatedReq = result.rows[0];
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${updatedReq.sender_id}`).emit('friend:request_accepted');
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reject/Remove friend
router.delete('/reject/:id', isAuthenticated, async (req, res) => {
  const requestId = parseInt(req.params.id);
  const userId = req.user.id;

  try {
    // Can only delete if user is sender or receiver
    const result = await pool.query(`
      DELETE FROM friend_requests
      WHERE id = $1 AND (sender_id = $2 OR receiver_id = $2)
      RETURNING *
    `, [requestId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
