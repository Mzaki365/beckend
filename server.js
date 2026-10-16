// server.js - Storelistener Backend Server
require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const { analyzeRealtimeChunk } = require('./services/aiService');
const { createStreamingSession } = require('./services/sttAdapter');
const storeSyncService = require('./services/storeSyncService');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./middleware/auth');

const activeSTTSessions = new Map();

const app = express();
// Enable trust proxy for Render reverse-proxy HTTPS protocol and cookie header forwarding
app.set('trust proxy', 1);

const server = http.createServer(app);

// Allowed frontend origins for credentialed requests
const allowedOrigins = [
  'https://storelistener-frontend.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:3000',
  'http://localhost:5000',
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL.replace(/\/$/, ''));
}
if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(',').forEach((o) => {
    if (o.trim()) allowedOrigins.push(o.trim().replace(/\/$/, ''));
  });
}

function isOriginAllowed(origin) {
  if (!origin || origin === 'null') return true; // Electron, mobile apps, curl, server-to-server
  if (origin.startsWith('file://') || origin.startsWith('file:')) return true;
  const clean = origin.replace(/\/+$/, '');
  if (clean.startsWith('file:')) return true;
  if (allowedOrigins.includes(clean) || allowedOrigins.includes(origin)) return true;
  if (clean.startsWith('http://localhost:') || clean.startsWith('http://127.0.0.1:')) return true;
  // Allow canonical and preview deployments for storelistener-frontend on Vercel
  if (/^https:\/\/storelistener-frontend.*\.vercel\.app$/.test(clean)) return true;
  return false;
}

// Enable Socket.IO with CORS mounted at standard /socket.io/
const io = new Server(server, {
  path: '/socket.io/',
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Middleware: Credentialed CORS
app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Set-Cookie']
}));

// Middleware: Fast lightweight cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      const name = parts[0]?.trim();
      const val = parts.slice(1).join('=').trim();
      if (name) req.cookies[name] = decodeURIComponent(val);
    });
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve recorded audio files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Attach io instance to express app so routes can broadcast
app.set('io', io);

// Database connection & initialization (optimized for Vercel Serverless with cached connection promise)
let dbPromise = null;
async function initDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (dbPromise) return dbPromise;

  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://sarfrazafzal790_db_user:uf5VWKdvIil4yXUS@storelistener.sy7em7l.mongodb.net/storelistener?retryWrites=true&w=majority&appName=Storelistener';

  dbPromise = mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000
  }).then(async (conn) => {
    console.log('✅ Connected successfully to MongoDB Atlas');
    try {
      await authRoutes.seedDefaultUsers();
      await storeSyncService.ensureStoresInDatabase();
      const dailyReportService = require('./services/dailyReportService');
      await dailyReportService.ensureDefaultInventory();
    } catch (seedErr) {
      console.warn('Seeding note:', seedErr.message);
    }
    return conn;
  }).catch((err) => {
    dbPromise = null;
    console.warn('⚠️ MongoDB Atlas Connection Note:', err.message);
    console.log('Using resilient local persistence fallback for JWT & user management...');
    try {
      authRoutes.seedDefaultUsers();
    } catch (seedErr) {}
  });

  return dbPromise;
}

// Middleware to ensure DB connection is ready before processing API requests
app.use(async (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    try {
      await initDatabase();
    } catch (e) {
      // Continue gracefully with local fallback
    }
  }
  next();
});

// Mount API routes
app.use('/api/auth', authRoutes.router);
app.use('/api', apiRoutes);

// Root information endpoint
app.get('/', (req, res) => {
  res.json({
    appName: 'Storelistener Server API',
    status: 'online',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      api: '/api',
      health: '/healthz'
    }
  });
});

// Health check endpoints (supports both /health and /healthz)
app.get(['/health', '/healthz'], (req, res) => {
  res.json({
    status: 'online',
    appName: 'Storelistener Server',
    mongoStatus: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Real-time WebSocket connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // 1. Initial handshake authentication check (auth token, query, or HttpOnly cookie)
  let initialToken = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!initialToken && socket.handshake.headers?.cookie) {
    const match = socket.handshake.headers.cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (match) {
      initialToken = decodeURIComponent(match[1]);
    }
  }
  if (initialToken) {
    const user = storeSyncService.verifySocketAuth(initialToken);
    if (user) {
      storeSyncService.authenticatedSockets.set(socket.id, user);
      console.log(`🔑 Authenticated socket ${socket.id} as ${user.email} (${user.role})`);
    }
  }

  // Explicit authentication message
  socket.on('authenticate', (token, callback) => {
    const user = storeSyncService.verifySocketAuth(token);
    if (user) {
      storeSyncService.authenticatedSockets.set(socket.id, user);
      if (typeof callback === 'function') {
        callback({ success: true, user: { id: user.id, role: user.role, storeCode: user.storeCode } });
      }
    } else {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Invalid or expired authentication token.' });
      }
    }
  });

  // 2. Store-specific room join with authorization guard
  socket.on('join_store', (storeCode, callback) => {
    const user = storeSyncService.authenticatedSockets.get(socket.id);
    if (user && !storeSyncService.canUserAccessStore(user, storeCode)) {
      console.warn(`⛔ [Auth Guard] Socket ${socket.id} rejected from store ${storeCode}`);
      if (typeof callback === 'function') {
        return callback({ success: false, error: 'Unauthorized to monitor this store branch.' });
      }
      return;
    }
    socket.join(`store_${storeCode}`);
    console.log(`Socket ${socket.id} joined store: ${storeCode}`);
    if (typeof callback === 'function') {
      callback({ success: true, storeCode });
    }
  });

  // Join a specific conversation session
  socket.on('join_session', (sessionId) => {
    socket.join(`session_${sessionId}`);
    console.log(`Socket ${socket.id} joined session: ${sessionId}`);
  });

  // Request live store overview on demand
  socket.on('get_stores_overview', (callback) => {
    const statuses = storeSyncService.getAllStoreStatuses();
    if (typeof callback === 'function') {
      callback(statuses);
    } else {
      socket.emit('stores_overview_update', statuses);
    }
  });

  // 3. Store Heartbeat Handling (Module 5)
  socket.on('store_heartbeat', (data) => {
    storeSyncService.handleHeartbeat(socket, io, data);
  });

  socket.on('device_heartbeat', (data) => {
    storeSyncService.handleHeartbeat(socket, io, data);
  });

  // 4. Session Lifecycle Events (Module 5)
  socket.on('session_start', (data) => {
    storeSyncService.handleSessionStart(socket, io, data);
  });

  socket.on('session_stop', (data) => {
    storeSyncService.handleSessionEnd(socket, io, data);
  });

  socket.on('session_end', (data) => {
    storeSyncService.handleSessionEnd(socket, io, data);
  });

  // Stream live audio frequency/volume levels for real-time visualization
  socket.on('audio_level', (data) => {
    if (data && data.sessionId) {
      socket.to(`session_${data.sessionId}`).emit('live_audio_level', data);
    }
    socket.broadcast.emit('global_audio_pulse', data);
  });

  // 5. Live Audio Monitoring Subscription & Relay (Module 5)
  socket.on('audio_monitoring_subscribe', (payload = {}, callback) => {
    const token = payload.token || socket.handshake.auth?.token;
    let user = storeSyncService.authenticatedSockets.get(socket.id);
    if (!user && token) {
      user = storeSyncService.verifySocketAuth(token);
      if (user) storeSyncService.authenticatedSockets.set(socket.id, user);
    }

    const targetStoreCode = payload.storeCode || (payload.sessionId ? storeSyncService.getSessionStoreCode(payload.sessionId) : null) || 'STORE-01';

    if (user && targetStoreCode && !storeSyncService.canUserAccessStore(user, targetStoreCode)) {
      console.warn(`⛔ [Audio Guard] Unauthorized audio monitoring request from ${socket.id} for store ${targetStoreCode}`);
      socket.emit('audio_monitoring_error', { success: false, error: 'Unauthorized to monitor audio for this store. Access denied.' });
      if (typeof callback === 'function') {
        return callback({ success: false, error: 'Unauthorized to monitor audio for this store. Access denied.' });
      }
      return;
    }

    if (payload.sessionId) {
      socket.join(`audio_session_${payload.sessionId}`);
      console.log(`🎧 Socket ${socket.id} subscribed to live audio for session ${payload.sessionId}`);
      socket.emit('audio_monitoring_subscribed', { success: true, sessionId: payload.sessionId });
      if (typeof callback === 'function') {
        callback({ success: true, sessionId: payload.sessionId });
      }
    } else {
      socket.emit('audio_monitoring_error', { success: false, error: 'sessionId is required for audio subscription.' });
      if (typeof callback === 'function') {
        callback({ success: false, error: 'sessionId is required for audio subscription.' });
      }
    }
  });

  socket.on('audio_monitoring_unsubscribe', (payload = {}) => {
    if (payload.sessionId) {
      socket.leave(`audio_session_${payload.sessionId}`);
      console.log(`🎧 Socket ${socket.id} unsubscribed from live audio for session ${payload.sessionId}`);
    }
  });

  // Relay live audio chunks strictly to authorized listeners of this session
  socket.on('live_audio_chunk', (data) => {
    if (data && data.sessionId) {
      io.to(`audio_session_${data.sessionId}`).emit('admin_live_audio', data);
    }
  });

  socket.on('live_audio_data', (data) => {
    if (data && data.sessionId) {
      io.to(`audio_session_${data.sessionId}`).emit('admin_live_audio', data);
    }
  });

  // Real-time live transcript stream from Store Desktop App
  socket.on('live_transcript_stream', (data) => {
    storeSyncService.handleTranscriptSegment(socket, io, data);

    const { text = '' } = data || {};
    const realtimeAI = analyzeRealtimeChunk(text);

    if (realtimeAI.isClosingSignal) {
      io.emit('deal_closure_detected', {
        sessionId: data.sessionId,
        signal: realtimeAI.closingMatch,
        text,
        timestamp: new Date()
      });
    }

    if (realtimeAI.copilotTip) {
      socket.emit('copilot_suggestion', {
        tip: realtimeAI.copilotTip,
        trigger: text
      });
    }
  });

  socket.on('transcript_stream_chunk', (data) => {
    storeSyncService.handleTranscriptSegment(socket, io, data);
  });

  // -------------------------------------------------------------
  // Module 4 & 5: Real-Time Speech-to-Text Streaming Gateway
  // -------------------------------------------------------------
  socket.on('stt_start_session', (payload = {}) => {
    const {
      sessionId,
      storeCode = 'STORE-01',
      language = 'multi',
      targetLanguage = 'en',
      model = 'nova-3',
      authToken,
    } = payload;

    if (!sessionId) {
      return socket.emit('stt_error', { error: 'sessionId is required to start transcription.' });
    }

    // Authenticate session if token is provided
    if (authToken) {
      try {
        jwt.verify(authToken, JWT_SECRET);
      } catch (err) {
        console.warn(`[STT Auth] Token validation rejected for session ${sessionId}:`, err.message);
        return socket.emit('stt_error', {
          error: 'Authentication failed: Invalid or expired authorization token.',
          sessionId,
        });
      }
    }

    // Sync session start with StoreSyncService (Module 5)
    storeSyncService.handleSessionStart(socket, io, payload);

    // Clean up previous active session on this socket if any
    if (activeSTTSessions.has(socket.id)) {
      try {
        activeSTTSessions.get(socket.id).finish();
      } catch (e) {}
      activeSTTSessions.delete(socket.id);
    }

    console.log(`🎙️ [STT] Starting streaming session ${sessionId} for socket ${socket.id} (model: ${model})`);

    const sessionController = createStreamingSession({
      sessionId,
      storeCode,
      language,
      targetLanguage,
      model,
      onSegment: (segment) => {
        // Send to the active desktop recorder
        socket.emit('stt_transcript_segment', segment);

        // Sync with Module 5 live store session state
        storeSyncService.handleTranscriptSegment(socket, io, segment);
      },
      onStatus: (statusPayload) => {
        socket.emit('stt_status', statusPayload);
      },
      onError: (errPayload) => {
        socket.emit('stt_error', errPayload);
      },
      onClose: (closePayload) => {
        socket.emit('stt_closed', closePayload);
        activeSTTSessions.delete(socket.id);
      },
    });

    activeSTTSessions.set(socket.id, sessionController);
  });

  socket.on('stt_audio_chunk', (payload = {}) => {
    const { sessionId, chunk } = payload;
    const sessionController = activeSTTSessions.get(socket.id);

    if (!sessionController) {
      return;
    }

    try {
      let buffer;
      if (Buffer.isBuffer(chunk)) {
        buffer = chunk;
      } else if (typeof chunk === 'string') {
        buffer = Buffer.from(chunk, 'base64');
      } else if (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) {
        buffer = Buffer.from(chunk);
      }

      if (buffer && buffer.length > 0) {
        sessionController.sendAudioChunk(buffer);

        // Also relay to active audio listeners for Module 5 live monitoring
        io.to(`audio_session_${sessionId}`).emit('admin_live_audio', {
          sessionId,
          chunk: buffer,
        });
      }
    } catch (err) {
      console.warn(`[STT] Audio chunk forwarding note for ${sessionId}:`, err.message);
    }
  });

  socket.on('stt_stop_session', (payload = {}) => {
    const { sessionId } = payload;
    console.log(`⏹️ [STT] Stopping streaming session for socket ${socket.id} (sessionId: ${sessionId})`);

    const sessionController = activeSTTSessions.get(socket.id);
    if (sessionController) {
      sessionController.finish();
      activeSTTSessions.delete(socket.id);
    }
    socket.emit('stt_status', { status: 'stopped', sessionId });

    // Sync session end with StoreSyncService (Module 5)
    storeSyncService.handleSessionEnd(socket, io, payload);
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    storeSyncService.handleDisconnect(socket, io);
    if (activeSTTSessions.has(socket.id)) {
      try {
        activeSTTSessions.get(socket.id).finish();
      } catch (e) {}
      activeSTTSessions.delete(socket.id);
    }
  });
});



const PORT = process.env.PORT || 5000;

// If running directly as a standalone process (Node.js runtime)
if (require.main === module) {
  initDatabase().then(() => {
    storeSyncService.startHeartbeatMonitor(io);
    server.listen(PORT, () => {
      console.log(`🚀 Storelistener Backend running on port ${PORT}`);
      console.log(`📡 WebSocket server ready for real-time live events`);
    });
  });
}

module.exports = { app, server, io, initDatabase };
module.exports.default = app;
