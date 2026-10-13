/**
 * Storelistener — Streaming Speech-to-Text Provider Adapter (Module 4)
 * File: services/sttAdapter.js
 *
 * Implements Deepgram WebSocket Live Streaming API (wss://api.deepgram.com/v1/listen)
 * Features:
 * - Nova-3 model streaming with smart formatting and punctuation
 * - Interim and final transcript distinction
 * - Diarization support for speaker differentiation
 * - Safe unconfigured fallback when DEEPGRAM_API_KEY is not set
 * - Clean connection lifecycle and resource cleanup
 */

const WebSocket = require('ws');
const { translateToEnglish } = require('./translationService');

/**
 * Creates a real-time streaming STT session
 * @param {Object} options
 * @param {string} options.sessionId - Unique conversation session ID
 * @param {string} options.storeCode - Store identifier (e.g., 'STORE-NYC-01')
 * @param {string} options.language - Language code (default: 'multi' for multilingual / Spanish)
 * @param {string} options.targetLanguage - Target output language (default: 'en')
 * @param {string} options.model - Model name (default: 'nova-3')
 * @param {Function} options.onSegment - Callback when transcript segment arrives
 * @param {Function} options.onStatus - Callback for connection status updates
 * @param {Function} options.onError - Callback for errors
 * @param {Function} options.onClose - Callback when session closes
 * @returns {Object} Session controller with sendAudioChunk(buffer) and finish()
 */
function createStreamingSession({
  sessionId,
  storeCode = 'STORE-NYC-01',
  language = 'multi',
  targetLanguage = 'en',
  model = 'nova-3',
  onSegment,
  onStatus,
  onError,
  onClose,
}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  // 1. Safe Unconfigured State Check
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_deepgram_api_key')) {
    if (onStatus) {
      onStatus({
        status: 'unconfigured',
        provider: 'deepgram',
        model,
        message: 'DEEPGRAM_API_KEY is not configured in backend .env. Set DEEPGRAM_API_KEY to enable live cloud transcription.',
      });
    }

    return {
      isConfigured: false,
      sendAudioChunk: () => {},
      finish: () => {
        if (onClose) onClose({ reason: 'unconfigured' });
      },
    };
  }

  // 2. Build Deepgram WebSocket URL
  // Parameters verified per Deepgram official documentation:
  // - model: 'nova-3'
  // - language: 'multi' enables multilingual recognition (Spanish, English, etc.)
  // - smart_format: true (auto-formats dates, numbers, currency)
  // - punctuate: true
  // - interim_results: true (delivers streaming partials)
  // - diarize: true (identifies speaker turns)
  const queryParams = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || model || 'nova-3',
    language: 'multi',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    diarize: 'true',
    utterance_end_ms: '1500',
  });

  const deepgramUrl = `wss://api.deepgram.com/v1/listen?${queryParams.toString()}`;

  let ws = null;
  let isConnected = false;
  let isClosing = false;
  let bufferedChunks = [];

  try {
    ws = new WebSocket(deepgramUrl, {
      headers: {
        Authorization: `Token ${apiKey.trim()}`,
      },
    });

    if (onStatus) {
      onStatus({
        status: 'connecting',
        provider: 'deepgram',
        model,
        sessionId,
      });
    }

    ws.on('open', () => {
      isConnected = true;
      if (onStatus) {
        onStatus({
          status: 'connected',
          provider: 'deepgram',
          model,
          sessionId,
        });
        onStatus({
          status: 'active',
          provider: 'deepgram',
          model,
          sessionId,
        });
      }

      // Flush any audio chunks received while handshake was establishing
      while (bufferedChunks.length > 0) {
        const chunk = bufferedChunks.shift();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      }
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle Deepgram Results payload
        if (message.type === 'Results' && message.channel) {
          const alternative = message.channel.alternatives && message.channel.alternatives[0];
          const transcriptText = alternative?.transcript?.trim();

          if (transcriptText && transcriptText.length > 0) {
            const isFinal = Boolean(message.is_final || message.speech_final);

            // Determine speaker label from word diarization if present
            let speakerLabel = null;
            if (alternative.words && alternative.words.length > 0) {
              const firstWord = alternative.words[0];
              if (firstWord && typeof firstWord.speaker === 'number') {
                speakerLabel = `Speaker ${firstWord.speaker}`;
              }
            }

            const startTime = typeof message.start === 'number' ? message.start : null;
            const duration = typeof message.duration === 'number' ? message.duration : null;
            const endTime = startTime !== null && duration !== null ? Number((startTime + duration).toFixed(2)) : null;

            // Perform English translation pipeline for multilingual speech (Spanish, etc.)
            let englishText = transcriptText;
            let originalText = transcriptText;
            let wasTranslated = false;
            let sourceLanguage = 'en';

            try {
              const translationResult = await translateToEnglish(transcriptText);
              if (translationResult) {
                englishText = translationResult.englishText || transcriptText;
                originalText = translationResult.originalText || transcriptText;
                wasTranslated = translationResult.wasTranslated || false;
                sourceLanguage = translationResult.sourceLanguage || 'en';
              }
            } catch (transErr) {
              console.warn(`[STT Translation] Note for session ${sessionId}:`, transErr.message);
            }

            const segment = {
              segmentId: `seg_${sessionId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              sessionId,
              speaker: speakerLabel || 'Speaker',
              text: englishText,
              originalText: wasTranslated ? originalText : undefined,
              isTranslated: wasTranslated,
              sourceLanguage,
              targetLanguage: 'en',
              confidence: alternative.confidence || 0.95,
              startTime,
              endTime,
              isFinal,
              receivedAt: new Date().toISOString(),
            };

            if (onSegment) {
              onSegment(segment);
            }
          }
        }
      } catch (err) {
        console.warn(`[Deepgram] Parse note for session ${sessionId}:`, err.message);
      }
    });

    ws.on('error', (err) => {
      console.error(`[Deepgram STT] WebSocket Error for session ${sessionId}:`, err.message);
      if (onError) {
        onError({
          error: `Speech-to-text connection error: ${err.message}`,
          sessionId,
        });
      }
    });

    ws.on('close', (code, reason) => {
      isConnected = false;
      const reasonStr = reason ? reason.toString() : '';
      if (onClose) {
        onClose({
          code,
          reason: reasonStr,
          sessionId,
        });
      }
    });
  } catch (initErr) {
    console.error(`[Deepgram STT] Failed to initialize session ${sessionId}:`, initErr);
    if (onError) {
      onError({ error: initErr.message, sessionId });
    }
  }

  return {
    isConfigured: true,
    sendAudioChunk: (chunk) => {
      if (isClosing || !chunk) return;
      if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      } else if (bufferedChunks.length < 50) {
        // Buffer up to 50 slices during connection handshakes
        bufferedChunks.push(chunk);
      }
    },
    finish: () => {
      isClosing = true;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          // Deepgram official close stream protocol message
          ws.send(JSON.stringify({ type: 'CloseStream' }));
          setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          }, 500);
        } catch (e) {
          ws.close();
        }
      }
      bufferedChunks = [];
    },
  };
}

module.exports = {
  createStreamingSession,
};
