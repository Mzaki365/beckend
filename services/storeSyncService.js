/**
 * Storelistener Backend — Real-Time Store & Session Synchronization Service (Module 5)
 * File: services/storeSyncService.js
 *
 * Implements:
 * 1. Live Store Connectivity State Machine (Idle, Listening, Recording, Offline)
 * 2. Real-time Heartbeat & Stale Connection Monitor (< 15s threshold)
 * 3. MongoDB Persistence for Session Metadata & Finalized Transcripts
 * 4. Authenticated Real-Time Event Routing for Store Owners & Dashboards
 * 5. Low-latency Live Audio Monitoring Stream Authorization & Relay
 */

const jwt = require('jsonwebtoken');
const Store = require('../models/Store');
const Session = require('../models/Session');
const { JWT_SECRET } = require('../middleware/auth');

// Canonical Store Definitions matching the 3 configured iPhone retail branches
const DEFAULT_STORE_CONFIGS = [
  {
    id: 'store-01',
    code: 'STORE-01',
    aliases: ['STR-01', 'STORE-NYC-01', 'store-01'],
    name: 'iPhone Store 01',
    location: 'Flagship - 5th Ave, New York',
    manager: 'David Miller',
    workstationsCount: 3,
  },
  {
    id: 'store-02',
    code: 'STORE-02',
    aliases: ['STR-02', 'STORE-LA-02', 'store-02'],
    name: 'iPhone Store 02',
    location: 'Galleria - Beverly Hills, Los Angeles',
    manager: 'Sarah Jenkins',
    workstationsCount: 3,
  },
  {
    id: 'store-03',
    code: 'STORE-03',
    aliases: ['STR-03', 'STORE-MIA-03', 'store-03'],
    name: 'iPhone Store 03',
    location: 'Metropolitan - Brickell, Miami',
    manager: 'Carlos Rodriguez',
    workstationsCount: 2,
  },
];

class StoreSyncService {
  constructor() {
    // In-memory store state map: storeId -> state object
    this.storeStates = new Map();
    // Socket to store mapping: socketId -> storeId
    this.socketToStore = new Map();
    // Socket authentication cache: socketId -> user object
    this.authenticatedSockets = new Map();
    // Active session transcript buffers: sessionId -> array of segments
    this.activeTranscripts = new Map();
    // Session to store mapping: sessionId -> store config
    this.sessionToStore = new Map();

    this.heartbeatTimer = null;
    this.staleThresholdMs = 15000; // 15 seconds stale threshold

    this.initializeStateMap();
  }

  /**
   * Initializes the in-memory state map for all configured stores
   */
  initializeStateMap() {
    for (const cfg of DEFAULT_STORE_CONFIGS) {
      this.storeStates.set(cfg.id, {
        id: cfg.id,
        code: cfg.code,
        name: cfg.name,
        location: cfg.location,
        manager: cfg.manager,
        status: 'Offline', // 'Online' | 'Offline'
        currentState: 'Offline', // 'Idle' | 'Listening' | 'Recording' | 'Offline'
        lastHeartbeat: null,
        activeConversationsCount: 0,
        workstationsCount: cfg.workstationsCount,
        connectedSockets: new Set(),
        activeSession: null, // { sessionId, title, startedAt, durationSeconds }
      });
    }
  }

  /**
   * Resolves store config by any alias (id, code, or alternative alias)
   */
  findStoreConfig(storeIdentifier) {
    if (!storeIdentifier) return DEFAULT_STORE_CONFIGS[0];
    const cleanId = String(storeIdentifier).trim().toLowerCase();
    for (const cfg of DEFAULT_STORE_CONFIGS) {
      if (cfg.id.toLowerCase() === cleanId) return cfg;
      if (cfg.code.toLowerCase() === cleanId) return cfg;
      if (cfg.aliases.some((a) => a.toLowerCase() === cleanId)) return cfg;
    }
    return DEFAULT_STORE_CONFIGS[0];
  }

  /**
   * Seeds stores into MongoDB and syncs with database
   */
  async ensureStoresInDatabase() {
    try {
      for (const cfg of DEFAULT_STORE_CONFIGS) {
        const existing = await Store.findOne({
          $or: [{ storeCode: cfg.code }, { storeCode: cfg.id.toUpperCase() }],
        });

        if (!existing) {
          await Store.create({
            storeCode: cfg.code,
            name: cfg.name,
            location: cfg.location,
            manager: cfg.manager,
            isActive: true,
          });
          console.log(`🏬 Seeded store in MongoDB: ${cfg.code} (${cfg.name})`);
        }
      }
    } catch (err) {
      console.warn('Store MongoDB synchronization notice:', err.message);
    }
  }

  /**
   * Verifies socket authentication token
   */
  verifySocketAuth(token) {
    if (!token) return null;
    try {
      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
      return jwt.verify(cleanToken, JWT_SECRET);
    } catch (e) {
      return null;
    }
  }

  /**
   * Checks if user has authorization to access a given store
   */
  canUserAccessStore(user, storeIdentifier) {
    if (!user) return false;
    // Store admin (Owner) has full access across all stores
    if (user.role === 'store_admin') return true;

    // Sales manager is restricted to their assigned store
    if (user.role === 'sales_manager') {
      const targetConfig = this.findStoreConfig(storeIdentifier);
      const userStoreConfig = this.findStoreConfig(user.storeCode);
      return targetConfig.id === userStoreConfig.id;
    }

    return false;
  }

  /**
   * Returns snapshot of all live store statuses for owner dashboard
   */
  getAllStoreStatuses() {
    const list = [];
    const now = Date.now();

    for (const [id, state] of this.storeStates.entries()) {
      let liveState = state.currentState;
      let isOnline = state.status === 'Online';

      // Check if connection is stale (> 15 seconds without heartbeat)
      if (state.lastHeartbeat && now - new Date(state.lastHeartbeat).getTime() > this.staleThresholdMs) {
        liveState = 'Offline';
        isOnline = false;
      }

      // Compute live duration if recording
      let activeSessionData = null;
      if (state.activeSession && isOnline && liveState === 'Recording') {
        const startedTime = new Date(state.activeSession.startedAt).getTime();
        const durationSec = Math.max(0, Math.floor((now - startedTime) / 1000));
        activeSessionData = {
          ...state.activeSession,
          durationSeconds: durationSec,
        };
      }

      list.push({
        id: state.id,
        code: state.code,
        name: state.name,
        location: state.location,
        status: isOnline ? 'Online' : 'Offline',
        currentState: liveState,
        activeConversations: activeSessionData ? 1 : 0,
        workstationsCount: state.workstationsCount,
        lastHeartbeat: state.lastHeartbeat,
        activeSession: activeSessionData,
      });
    }

    return list;
  }

  /**
   * Handles device/desktop heartbeat
   */
  handleHeartbeat(socket, io, payload = {}) {
    const { storeId, storeCode, status = 'Listening', activeSessionId, activeSessionTitle, activeSessionStartedAt } = payload;
    const cfg = this.findStoreConfig(storeId || storeCode);
    const storeState = this.storeStates.get(cfg.id);
    if (!storeState) return;

    const previousStatus = storeState.status;
    const previousState = storeState.currentState;

    storeState.lastHeartbeat = new Date();
    storeState.status = 'Online';
    storeState.connectedSockets.add(socket.id);
    this.socketToStore.set(socket.id, cfg.id);

    // If an active session is running on the terminal
    if (activeSessionId) {
      storeState.currentState = 'Recording';
      storeState.activeConversationsCount = 1;
      storeState.activeSession = {
        sessionId: activeSessionId,
        title: activeSessionTitle || 'Customer Consultation',
        startedAt: activeSessionStartedAt || new Date().toISOString(),
      };
    } else {
      storeState.currentState = status === 'Recording' ? 'Recording' : status === 'Idle' ? 'Idle' : 'Listening';
      if (storeState.currentState !== 'Recording') {
        storeState.activeSession = null;
        storeState.activeConversationsCount = 0;
      }
    }

    // Broadcast update if status or state changed
    if (previousStatus !== storeState.status || previousState !== storeState.currentState) {
      this.broadcastStoreStatus(io, cfg.id);

      if (previousStatus === 'Offline' && storeState.status === 'Online') {
        try {
          const notificationService = require('./notificationService');
          notificationService.createNotification({
            idempotencyKey: `store_online:${cfg.code}:${Math.floor(Date.now() / 60000)}`,
            type: 'store_online',
            title: `${cfg.name} Connected`,
            description: `Desktop counter application at ${cfg.name} (${cfg.code}) came online.`,
            severity: 'info',
            storeId: cfg.id,
            storeCode: cfg.code,
            storeName: cfg.name,
          }, io);
        } catch (e) {
          // Non-blocking
        }
      }
    }
  }

  /**
   * Handles session start notification from Desktop
   */
  async handleSessionStart(socket, io, payload = {}) {
    const { sessionId, storeId, storeCode, title, startedAt, salesRep } = payload;
    if (!sessionId) return;

    const cfg = this.findStoreConfig(storeId || storeCode);
    const storeState = this.storeStates.get(cfg.id);

    const now = new Date();
    const sessionStartTime = startedAt ? new Date(startedAt) : now;

    if (storeState) {
      storeState.status = 'Online';
      storeState.currentState = 'Recording';
      storeState.activeConversationsCount = 1;
      storeState.lastHeartbeat = now;
      storeState.activeSession = {
        sessionId,
        title: title || 'Customer Consultation',
        startedAt: sessionStartTime.toISOString(),
      };
      storeState.connectedSockets.add(socket.id);
      this.socketToStore.set(socket.id, cfg.id);
    }

    // Map session ID to store config
    this.sessionToStore.set(sessionId, cfg);

    // Initialize transcript segment buffer
    this.activeTranscripts.set(sessionId, []);

    // Persist or upsert in MongoDB
    try {
      await Session.findOneAndUpdate(
        { sessionId },
        {
          sessionId,
          storeCode: cfg.code,
          storeName: cfg.name,
          deviceId: 'terminal-01',
          salesRep: salesRep || 'Sales Specialist',
          status: 'active',
          startedAt: sessionStartTime,
          transcripts: [],
        },
        { upsert: true, new: true }
      );
      console.log(`💾 [Session Sync] Registered active session in MongoDB: ${sessionId} (${cfg.name})`);
    } catch (err) {
      console.warn('[Session Sync] MongoDB upsert note:', err.message);
    }

    // Broadcast to owner dashboard
    const broadcastPayload = {
      sessionId,
      storeId: cfg.id,
      storeCode: cfg.code,
      storeName: cfg.name,
      title: title || 'Customer Consultation',
      startedAt: sessionStartTime.toISOString(),
      status: 'active',
    };

    io.emit('session_started', broadcastPayload);
    io.to(`store_${cfg.code}`).emit('store_session_started', broadcastPayload);
    this.broadcastStoreStatus(io, cfg.id);

    try {
      const notificationService = require('./notificationService');
      notificationService.createNotification({
        idempotencyKey: `conversation_started:${sessionId}`,
        type: 'conversation_started',
        title: `New Conversation Started`,
        description: `Active dialogue detected at ${cfg.name} (${salesRep || 'Sales Specialist'}).`,
        severity: 'info',
        storeId: cfg.id,
        storeCode: cfg.code,
        storeName: cfg.name,
        sessionId,
        salesRep: salesRep || 'Sales Specialist',
      }, io);
    } catch (e) {
      // Non-blocking
    }
  }

  /**
   * Handles incoming transcript segment and syncs to MongoDB
   */
  async handleTranscriptSegment(socket, io, payload = {}) {
    const { sessionId, text, speaker = 'Customer', isFinal = false, timestamp, segmentId, sourceLanguage, isTranslated } = payload;
    if (!sessionId || !text || !text.trim()) return;

    // Ensure translation to canonical English text if incoming segment is not yet translated
    let englishText = text.trim();
    let originalText = payload.originalText || text.trim();
    let wasTranslated = !!payload.isTranslated;
    let detectedSourceLang = payload.sourceLanguage || 'en';

    if (!wasTranslated) {
      try {
        const { translateToEnglish } = require('./translationService');
        const translationResult = await translateToEnglish(text);
        if (translationResult && translationResult.wasTranslated) {
          englishText = translationResult.englishText;
          originalText = translationResult.originalText || text.trim();
          wasTranslated = true;
          detectedSourceLang = translationResult.sourceLanguage || 'es';
        }
      } catch (trErr) {
        console.warn(`[Session Sync] Translation note for ${sessionId}:`, trErr.message);
      }
    }

    // Ensure Devanagari script is never emitted as canonical English
    if (/[\u0900-\u097F]/.test(englishText)) {
      englishText = '[Translation unavailable: non-English speech]';
    }

    const cfg = this.sessionToStore.get(sessionId) || this.findStoreConfig(this.getSessionStoreCode(sessionId) || payload.storeId || payload.storeCode);
    const buffer = this.activeTranscripts.get(sessionId) || [];
    const item = {
      segmentId: segmentId || `seg_${sessionId}_${Date.now()}`,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      speaker: speaker || 'Customer',
      text: englishText,
      englishText: englishText,
      originalText: originalText,
      isFinal: !!isFinal,
      sourceLanguage: detectedSourceLang,
      isTranslated: wasTranslated,
      confidence: payload.confidence != null ? payload.confidence : 0.95,
    };

    if (isFinal) {
      // Deduplication guard: deduplicate strictly by segmentId
      const isDuplicate = buffer.some((b) => b.segmentId === item.segmentId);

      if (!isDuplicate) {
        buffer.push(item);
        this.activeTranscripts.set(sessionId, buffer);

        // Persist finalized canonical English segment to MongoDB Session
        try {
          await Session.updateOne(
            { sessionId },
            {
              $push: {
                transcripts: {
                  timestamp: item.timestamp,
                  speaker: item.speaker.toLowerCase().includes('sales') ? 'sales_rep' : 'customer',
                  text: item.text,
                  englishText: item.englishText,
                  originalText: item.originalText,
                  sourceLanguage: item.sourceLanguage,
                  isTranslated: item.isTranslated,
                  confidence: item.confidence,
                },
              },
            }
          );
        } catch (err) {
          console.warn('[Session Sync] Transcript persistence note:', err.message);
        }
      }
    }

    const broadcastChunk = {
      sessionId,
      storeId: cfg.id,
      storeCode: cfg.code,
      storeName: cfg.name,
      ...item,
    };

    // Broadcast canonical English chunk to authorized listeners of this session
    io.to(`session_${sessionId}`).emit('transcript_stream_chunk', broadcastChunk);
    io.to(`store_${cfg.code}`).emit('transcript_stream_chunk', broadcastChunk);
    // Broadcast to dashboard overview and live monitoring
    io.emit('transcript_stream_chunk', broadcastChunk);
    // Broadcast to global live monitoring wall
    io.emit('live_monitor_event', broadcastChunk);
  }

  /**
   * Handles session completion / closure (e.g. 15s silence countdown)
   */
  async handleSessionEnd(socket, io, payload = {}) {
    const { sessionId, storeId, storeCode, durationSeconds, endedAt, transcripts } = payload;
    if (!sessionId) return;

    const cfg = this.sessionToStore.get(sessionId) || this.findStoreConfig(storeId || storeCode);
    const storeState = this.storeStates.get(cfg.id);

    if (storeState) {
      storeState.currentState = 'Listening';
      storeState.activeConversationsCount = 0;
      storeState.activeSession = null;
    }

    const endTime = endedAt ? new Date(endedAt) : new Date();
    const bufferedSegments = transcripts || this.activeTranscripts.get(sessionId) || [];

    // Finalize session in MongoDB
    try {
      const updateData = {
        status: 'completed',
        endedAt: endTime,
      };

      if (durationSeconds) {
        updateData.durationSeconds = durationSeconds;
      }

      // If audioBase64 or base64Data is supplied in session_stop, persist audio file immediately
      if (payload.audioBase64 || payload.base64Data) {
        try {
          const fs = require('fs');
          const path = require('path');
          const uploadsDir = path.join(__dirname, '..', 'uploads');
          if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
          }
          const base64Data = payload.audioBase64 || payload.base64Data;
          const fileName = `session-${sessionId}-${Date.now()}.webm`;
          const filePath = path.join(uploadsDir, fileName);
          fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
          updateData.audioFileName = fileName;
          updateData.audioUrl = `/uploads/${fileName}`;
          console.log(`🎙️ [Session Sync] Audio saved and linked for session: ${sessionId} (${fileName})`);
        } catch (audioErr) {
          console.warn('[Session Sync] Audio save error:', audioErr.message);
        }
      }

      if (Array.isArray(bufferedSegments) && bufferedSegments.length > 0) {
        updateData.transcripts = bufferedSegments.map((s) => ({
          timestamp: s.timestamp ? new Date(s.timestamp) : new Date(),
          speaker: (s.speaker || '').toLowerCase().includes('sales') ? 'sales_rep' : 'customer',
          text: s.text || s.englishText || '',
          englishText: s.englishText || s.text || '',
          originalText: s.originalText || s.text || '',
          sourceLanguage: s.sourceLanguage || 'en',
          isTranslated: !!s.isTranslated,
          confidence: s.confidence || 0.95,
        }));
      }

      await Session.findOneAndUpdate({ sessionId }, updateData, { new: true });
      console.log(`✅ [Session Sync] Finalized and completed session in MongoDB: ${sessionId}`);
    } catch (err) {
      console.warn('[Session Sync] Finalize MongoDB session note:', err.message);
    }

    this.activeTranscripts.delete(sessionId);

    const endPayload = {
      sessionId,
      storeId: cfg.id,
      storeCode: cfg.code,
      storeName: cfg.name,
      status: 'completed',
      endedAt: endTime.toISOString(),
      durationSeconds: durationSeconds || 0,
    };

    io.emit('session_ended', endPayload);
    io.to(`session_${sessionId}`).emit('session_closed', endPayload);
    io.to(`store_${cfg.code}`).emit('session_ended', endPayload);
    this.broadcastStoreStatus(io, cfg.id);

    try {
      const notificationService = require('./notificationService');
      notificationService.createNotification({
        idempotencyKey: `conversation_completed:${sessionId}`,
        type: 'conversation_completed',
        title: `Conversation Completed`,
        description: `Conversation ${sessionId} at ${cfg.name} concluded (${durationSeconds || 0}s).`,
        severity: 'info',
        storeId: cfg.id,
        storeCode: cfg.code,
        storeName: cfg.name,
        sessionId,
      }, io);
    } catch (e) {
      // Non-blocking
    }

    // Asynchronously trigger Module 6 Deal Analysis & Module 7 Scorecard for the finalized session (non-blocking)
    try {
      const dealAnalysisService = require('./dealAnalysisService');
      const scorecardService = require('./scorecardService');
      const notificationService = require('./notificationService');

      dealAnalysisService.runAnalysisForSession(sessionId).then((analysis) => {
        if (io && analysis) {
          io.emit('deal_analysis_updated', {
            sessionId,
            storeCode: cfg.code,
            storeId: cfg.id,
            dealAnalysis: analysis,
          });

          // Check outcome alerts
          if (analysis.conversationOutcome === 'Sale Confirmed') {
            notificationService.createNotification({
              idempotencyKey: `sale_confirmed:${sessionId}`,
              type: 'sale_confirmed',
              title: `Sale Confirmed at ${cfg.name}! 🎉`,
              description: `Confirmed sale finalized for ${(analysis.productsDiscussed || []).join(', ') || 'Apple hardware'}.`,
              severity: 'success',
              storeId: cfg.id,
              storeCode: cfg.code,
              storeName: cfg.name,
              sessionId,
              metadata: { products: analysis.productsDiscussed, price: analysis.budgetAndPrice },
            }, io);
          } else if (analysis.conversationOutcome === 'Follow-up Required') {
            notificationService.createNotification({
              idempotencyKey: `follow_up_required:${sessionId}`,
              type: 'follow_up_required',
              title: `Follow-up Required — ${cfg.name}`,
              description: `Customer requested follow-up action: ${analysis.nextRecommendedAction || 'Schedule next consultation'}.`,
              severity: 'warning',
              storeId: cfg.id,
              storeCode: cfg.code,
              storeName: cfg.name,
              sessionId,
            }, io);
          } else if (analysis.customerBuyingIntent === 'High' && analysis.conversationOutcome === 'Unclear') {
            notificationService.createNotification({
              idempotencyKey: `high_intent_unclear_outcome:${sessionId}`,
              type: 'high_intent_unclear_outcome',
              title: `High Intent — Unclear Outcome`,
              description: `High purchase interest observed at ${cfg.name}, but conversation concluded without a recorded outcome.`,
              severity: 'warning',
              storeId: cfg.id,
              storeCode: cfg.code,
              storeName: cfg.name,
              sessionId,
            }, io);
          }
        }

        // Trigger Module 7 Scorecard evaluation reusing dealAnalysis
        return scorecardService.evaluateSessionScorecard(sessionId);
      }).then((scorecard) => {
        if (io && scorecard) {
          io.emit('scorecard_updated', {
            sessionId,
            storeCode: cfg.code,
            storeId: cfg.id,
            scorecard,
          });
        }
      }).catch((err) => {
        console.warn(`[Analysis/Scorecard] Background evaluation notice for ${sessionId}:`, err.message);
        notificationService.createNotification({
          idempotencyKey: `analysis_failure:${sessionId}`,
          type: 'analysis_failure',
          title: `Assessment Failed`,
          description: `Analysis encountered an error for session ${sessionId}: ${err.message}`,
          severity: 'error',
          storeId: cfg.id,
          storeCode: cfg.code,
          storeName: cfg.name,
          sessionId,
        }, io);
      });
    } catch (e) {
      // Ignore background import error
    }
  }

  /**
   * Handles client socket disconnection
   */
  handleDisconnect(socket, io) {
    const storeId = this.socketToStore.get(socket.id);
    this.socketToStore.delete(socket.id);
    this.authenticatedSockets.delete(socket.id);

    if (storeId) {
      const storeState = this.storeStates.get(storeId);
      if (storeState) {
        storeState.connectedSockets.delete(socket.id);

        // If no more terminals are connected for this store, mark Offline
        if (storeState.connectedSockets.size === 0) {
          storeState.status = 'Offline';
          storeState.currentState = 'Offline';
          storeState.activeSession = null;
          storeState.activeConversationsCount = 0;
          this.broadcastStoreStatus(io, storeId);
        }
      }
    }
  }

  /**
   * Broadcasts updated status for a specific store or all stores
   */
  broadcastStoreStatus(io, storeId) {
    if (!io) return;
    const allStatuses = this.getAllStoreStatuses();
    const singleStore = allStatuses.find((s) => s.id === storeId);

    if (singleStore) {
      io.emit('store_status_update', singleStore);
    }
    io.emit('stores_overview_update', allStatuses);
  }

  /**
   * Starts background timer checking for stale connections (> 15 seconds)
   */
  startHeartbeatMonitor(io) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      let hasChanges = false;

      for (const [id, state] of this.storeStates.entries()) {
        if (state.status === 'Online' && state.lastHeartbeat) {
          const elapsed = now - new Date(state.lastHeartbeat).getTime();
          if (elapsed > this.staleThresholdMs) {
            console.log(`⏱️ [Heartbeat Monitor] Store ${state.code} connection became stale (${Math.round(elapsed / 1000)}s). Marking Offline.`);
            state.status = 'Offline';
            state.currentState = 'Offline';
            state.activeSession = null;
            state.activeConversationsCount = 0;
            state.connectedSockets.clear();
            hasChanges = true;

            try {
              const notificationService = require('./notificationService');
              notificationService.createNotification({
                idempotencyKey: `store_offline:${state.code}:${Math.floor(now / 60000)}`,
                type: 'store_offline',
                title: `${state.name} Disconnected`,
                description: `Desktop counter application at ${state.name} (${state.code}) went offline.`,
                severity: 'error',
                storeId: state.id,
                storeCode: state.code,
                storeName: state.name,
              }, io);
            } catch (e) {
              // Non-blocking
            }
          }
        }
      }

      if (hasChanges && io) {
        io.emit('stores_overview_update', this.getAllStoreStatuses());
      }
    }, 4000);
  }

  /**
   * Retrieves the store code for an active session
   */
  getSessionStoreCode(sessionId) {
    if (!sessionId) return null;
    for (const [id, state] of this.storeStates.entries()) {
      if (state.activeSession && state.activeSession.sessionId === sessionId) {
        return state.code;
      }
    }
    return null;
  }

  /**
   * Manually transitions a store to offline (e.g. on test disconnect or timeout)
   */
  markStoreOffline(storeIdentifier, io) {
    const cfg = this.findStoreConfig(storeIdentifier);
    const state = this.storeStates.get(cfg.id);
    if (state) {
      state.status = 'Offline';
      state.currentState = 'Offline';
      state.activeSession = null;
      state.activeConversationsCount = 0;
      state.connectedSockets.clear();
      if (io) {
        this.broadcastStoreStatus(io, cfg.id);
      }
    }
  }
}

const storeSyncService = new StoreSyncService();
module.exports = storeSyncService;
