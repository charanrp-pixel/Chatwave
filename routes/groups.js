const express = require('express');
const router = express.Router();
const { pool } = require('../db');

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Create a group
router.post('/', requireAuth, async (req, res) => {
  const { name, memberIds = [] } = req.body;
  const userId = req.user.id;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupResult = await client.query(
      'INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING *',
      [name.trim(), userId]
    );
    const group = groupResult.rows[0];

    // Add creator as admin
    await client.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
      [group.id, userId, 'admin']
    );

    // Add selected members
    for (const memberId of memberIds) {
      if (memberId !== userId) {
        await client.query(
          'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [group.id, memberId]
        );
      }
    }

    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) {
      memberIds.forEach(mId => {
        if (mId !== userId) {
          io.to(`user:${mId}`).emit('group:created', { groupId: group.id });
        }
      });
    }

    res.json({ ...group, member_count: memberIds.length + 1 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create group error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get user's groups
router.get('/', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query(
      `SELECT g.*,
        COUNT(DISTINCT gm2.user_id) as member_count,
        (SELECT content FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_at
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
       JOIN group_members gm2 ON gm2.group_id = g.id
       GROUP BY g.id
       ORDER BY last_message_at DESC NULLS LAST`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get groups error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get group messages
router.get('/:id/messages', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [id, userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const result = await pool.query(
      `SELECT gm.*, u.username, u.display_name, u.avatar_url as sender_avatar
       FROM group_messages gm
       JOIN users u ON u.id = gm.sender_id
       WHERE gm.group_id = $1
       ORDER BY gm.created_at ASC
       LIMIT 100`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get group messages error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get group members
router.get('/:id/members', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, gm.role
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY gm.role DESC, u.display_name ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete group / Leave group
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    const groupRes = await pool.query('SELECT created_by FROM groups WHERE id = $1', [id]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: 'Group not found' });

    if (groupRes.rows[0].created_by === userId) {
      await pool.query('DELETE FROM groups WHERE id = $1', [id]);
    } else {
      await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [id, userId]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete group error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
