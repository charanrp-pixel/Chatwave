require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');

const { pool, initializeDatabase } = require('./db');

// Prevent unhandled pool errors from crashing the process
pool.on('error', (err) => {
  console.error('⚠️  Unexpected DB pool error:', err.message);
});
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const messageRoutes = require('./routes/messages');
const { setupSocketHandlers } = require('./socket/handlers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.APP_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

const PORT = process.env.PORT || 3000;

// ─── Session (Memory Store — simple and reliable) ─────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Passport Google Strategy ─────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    const googleId = profile.id;
    const displayName = profile.displayName;
    const avatarUrl = profile.photos?.[0]?.value || null;

    // Upsert user
    const result = await pool.query(
      `INSERT INTO users (google_id, email, display_name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url
       RETURNING *`,
      [googleId, email, displayName, avatarUrl]
    );
    return done(null, result.rows[0]);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, result.rows[0] || false);
  } catch (err) {
    done(err);
  }
});

// Share session with Socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api', messageRoutes);

// Protect app pages
app.get('/app.html', (req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (!req.user.username) return res.redirect('/setup.html');
  next();
});

app.get('/setup.html', (req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (req.user.username) return res.redirect('/app.html');
  next();
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
setupSocketHandlers(io);

// ─── Start Server ─────────────────────────────────────────────────────────────
// Listen on 0.0.0.0 (required by Render)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Chat server running on port ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}`);

  // Initialize DB asynchronously after server is up
  initializeDatabase().catch((err) => {
    console.error('⚠️  DB init error (non-fatal):', err.message);
  });
});

// Required by Render to avoid 502 errors
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

server.on('error', (err) => {
  console.error('❌ Server error:', err);
});

// Catch unhandled errors so Render doesn't show 502
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});
