// services/sttService.js - Cloud Speech-to-Text Engine for Urdu, Punjabi & English
const fs = require('fs');
const path = require('path');

/**
 * Transcribe an audio buffer or file using Groq Whisper, OpenAI Whisper, or Google Gemini
 * @param {Buffer} audioBuffer - Binary audio data (webm, wav, etc.)
 * @param {string} mimeType - e.g. "audio/webm"
 * @param {string} language - 'ur' | 'pa' | 'en' | 'auto'
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/webm', language = 'ur') {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  // 1. Try Groq Whisper (Blazing fast ~250ms, exceptional for Urdu & Punjabi)
  if (groqKey) {
    try {
      const formData = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      formData.append('file', blob, 'audio.webm');
      formData.append('model', 'whisper-large-v3');
      if (language && language !== 'auto') {
        formData.append('language', language.startsWith('ur') ? 'ur' : (language.startsWith('pa') ? 'pa' : 'en'));
      }
      formData.append('response_format', 'json');

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`
        },
        body: formData
      });

      const data = await res.json();
      if (data && data.text) {
        return { text: data.text.trim(), provider: 'groq-whisper' };
      }
    } catch (err) {
      console.warn('Groq Whisper error:', err.message);
    }
  }

  // 2. Try OpenAI Whisper
  if (openaiKey) {
    try {
      const formData = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      formData.append('file', blob, 'audio.webm');
      formData.append('model', 'whisper-1');
      if (language && language !== 'auto') {
        formData.append('language', language.startsWith('ur') ? 'ur' : (language.startsWith('pa') ? 'pa' : 'en'));
      }

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`
        },
        body: formData
      });

      const data = await res.json();
      if (data && data.text) {
        return { text: data.text.trim(), provider: 'openai-whisper' };
      }
    } catch (err) {
      console.warn('OpenAI Whisper error:', err.message);
    }
  }

  // 3. Try Google Gemini Flash (multimodal audio)
  if (geminiKey) {
    try {
      const base64Audio = audioBuffer.toString('base64');
      const langPrompt = language.startsWith('ur') ? 'Urdu (اردو)' : (language.startsWith('pa') ? 'Punjabi (پنجابی)' : 'English or Urdu');
      
      const payload = {
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/webm',
                  data: base64Audio
                }
              },
              {
                text: `You are an accurate retail speech-to-text engine. Listen to this in-store audio clip and transcribe verbatim what was spoken in ${langPrompt}. If spoken in Urdu or Punjabi, transcribe in Urdu/Punjabi script or Roman script exactly as spoken. Return ONLY the transcribed text without any markdown or extra explanation. If silent or unintelligible, return an empty string.`
              }
            ]
          }
        ]
      };

      const modelsToTry = ['gemini-flash-latest', 'gemini-2.5-flash'];
      for (const model of modelsToTry) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const data = await res.json();
          const transcribed = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
          if (transcribed && transcribed !== 'SILENT' && transcribed !== 'SILENCE') {
            return { text: transcribed, provider: `gemini-${model}` };
          }
          if (data && !data.error) {
            // Success response but no speech in audio
            return { text: '', provider: `gemini-${model}` };
          }
        } catch (innerErr) {
          console.warn(`Gemini Audio STT (${model}) note:`, innerErr.message);
        }
      }
    } catch (err) {
      console.warn('Gemini Audio STT error:', err.message);
    }
  }

  // Fallback if no API key is provided
  return {
    text: '',
    provider: 'none',
    error: 'No Speech-to-Text API key configured (GROQ_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY required for live cloud transcription)'
  };
}

module.exports = {
  transcribeAudio
};
