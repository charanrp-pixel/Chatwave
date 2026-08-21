const express = require('express');
const { pool } = require('../db');
const { isAuthenticated } = require('../middleware/auth');
const router = express.Router();

// Get current user
router.get('/me', isAuthenticated, (req, res) => {
  const { id, email, username, display_name, avatar_url, is_online } = req.user;
  res.json({ id, email, username, display_name, avatar_url, is_online });
});

// Update profile (display name, avatar)
router.patch('/me', isAuthenticated, async (req, res) => {
  const { display_name, avatar_url } = req.body;
  const updates = [];
  const values = [];
  let i = 1;
  if (display_name !== undefined) { updates.push(`display_name = $${i++}`); values.push(display_name.trim() || null); }
  if (avatar_url !== undefined)   { updates.push(`avatar_url = $${i++}`);   values.push(avatar_url.trim() || null); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.user.id);
  try {
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, username, display_name, avatar_url, email`,
      values
    );
    const u = result.rows[0];
    req.user.display_name = u.display_name;
    req.user.avatar_url   = u.avatar_url;
    res.json({ success: true, user: u });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List all users endpoint removed for privacy reasons

// Set username (first-time setup)
router.post('/setup-username', isAuthenticated, async (req, res) => {
  const { username } = req.body;

  if (!username) return res.status(400).json({ error: 'Username is required' });

  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3-20 characters, letters, numbers, and underscores only'
    });
  }

  try {
    // Check if already taken
    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 AND id != $2',
      [username, req.user.id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const result = await pool.query(
      'UPDATE users SET username = $1 WHERE id = $2 RETURNING *',
      [username, req.user.id]
    );
    req.user.username = result.rows[0].username;
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Search users by username
router.get('/search', isAuthenticated, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.json({ users: [] });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, is_online, last_seen
       FROM users
       WHERE username ILIKE $1
         AND id != $2
         AND username IS NOT NULL
       ORDER BY username
       LIMIT 20`,
      [`%${q.trim()}%`, req.user.id]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a user profile by username
router.get('/profile/:username', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, display_name, avatar_url, is_online, last_seen FROM users WHERE username = $1',
      [req.params.username]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
