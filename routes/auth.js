const express = require('express');
const passport = require('passport');
const router = express.Router();

// Initiate Google OAuth login
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google OAuth callback
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    // If user has no username yet, redirect to setup
    if (!req.user.username) {
      return res.redirect('/setup.html');
    }
    res.redirect('/app.html');
  }
);

// Get current user info
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ user: null });
  }
  const { id, email, username, display_name, avatar_url } = req.user;
  res.json({ user: { id, email, username, display_name, avatar_url } });
});

// Logout
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });
});

module.exports = router;
