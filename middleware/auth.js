function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function isAuthenticatedRedirect(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

function hasUsername(req, res, next) {
  if (req.isAuthenticated() && req.user.username) return next();
  if (req.isAuthenticated() && !req.user.username) {
    return res.redirect('/setup.html');
  }
  res.redirect('/');
}

module.exports = { isAuthenticated, isAuthenticatedRedirect, hasUsername };
