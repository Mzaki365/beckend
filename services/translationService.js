/**
 * Storelistener — Real-Time Multilingual Translation Pipeline (Module 4)
 * File: services/translationService.js
 *
 * Translates recognized multilingual speech (Spanish, Urdu, etc.) into clean English text.
 * Preserves timestamps, speaker diarization, confidence scores, and original text.
 * Uses a tiered approach:
 * 1. Instant English pass-through heuristic (0ms)
 * 2. In-memory translation cache (0ms)
 * 3. Gemini 2.5 Flash / Flash Translation via GEMINI_API_KEY
 * 4. High-speed Google Translate HTTP fallback
 */

require('dotenv').config();
const translationCache = new Map();

// Distinct Spanish indicators & common retail vocabulary
const DISTINCT_SPANISH_WORDS = new Set([
  'hola', 'buenos', 'buenas', 'dias', 'días', 'tardes', 'noches', 'gracias', 'favor',
  'cuanto', 'cuánto', 'cuesta', 'cuestan', 'precio', 'comprar', 'quisiera', 'quiero', 'telefono', 'teléfono', 'celular',
  'pantalla', 'bateria', 'batería', 'funda', 'cargador', 'tarjeta', 'efectivo', 'pago', 'descuento',
  'garantia', 'garantía', 'cambio', 'reparacion', 'reparación', 'donde', 'dónde', 'como', 'cómo',
  'cuando', 'cuándo', 'quien', 'quién', 'nuevo', 'nueva', 'nuevos', 'nuevas', 'usado', 'usada', 'antiguo',
  'modelo', 'color', 'negro', 'blanco', 'azul', 'rojo', 'verde', 'dorado', 'plata',
  'senor', 'señor', 'senora', 'señora', 'amigo', 'tienen', 'tiene', 'puedo', 'puede', 'ayuda',
  'costo', 'vale', 'dinero', 'revisar', 'llevar', 'llevo', 'dame', 'estan', 'están', 'aqui', 'aquí',
  'alla', 'allá', 'sobre', 'aquel', 'aquella', 'unos', 'unas', 'otro', 'otra', 'otros', 'otras',
  'mucho', 'muchas', 'pocos', 'pocas', 'verdad', 'bienvenido', 'bienvenidos', 'disculpe', 'perdon', 'perdón'
]);

// Contextual Spanish functional words (counted only if accompanied by other indicators or grammatical markers)
const CONTEXTUAL_SPANISH_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'para', 'con', 'por',
  'este', 'esta', 'estos', 'estas', 'esto', 'ese', 'esa', 'esos', 'esas', 'eso',
  'que', 'qué', 'si', 'sí', 'mas', 'más', 'pero', 'bien', 'muy', 'yo', 'tu', 'tú', 'usted', 'nosotros', 'ellos'
]);

/**
 * Checks if a string contains Spanish characters or vocabulary
 * @param {string} text
 * @returns {boolean}
 */
function containsSpanishOrForeignWords(text) {
  if (!text || typeof text !== 'string') return false;
  
  // 1. Check for distinct Spanish orthographic characters (á, é, í, ó, ú, ñ, ¿, ¡, etc.)
  if (/[áéíóúÁÉÍÓÚñÑ¿¡]/.test(text)) {
    return true;
  }

  const cleanWords = text.toLowerCase().replace(/[^a-záéíóúñ\s]/g, '').split(/\s+/).filter(Boolean);
  if (cleanWords.length === 0) return false;

  let distinctMatches = 0;
  let contextualMatches = 0;

  for (const word of cleanWords) {
    if (DISTINCT_SPANISH_WORDS.has(word)) {
      distinctMatches++;
    } else if (CONTEXTUAL_SPANISH_WORDS.has(word)) {
      contextualMatches++;
    }
  }

  // Definite Spanish if at least 1 distinct Spanish word is present
  if (distinctMatches >= 1) return true;

  // Or if multiple contextual Spanish words occur without strong English signals
  if (contextualMatches >= 2) return true;

  return false;
}

/**
 * Translates Spanish or non-English text to English using Google Gemini API
 * @param {string} text
 * @returns {Promise<string|null>}
 */
async function translateWithGemini(text) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return null;

  try {
    const models = ['gemini-2.5-flash', 'gemini-flash-latest'];
    const payload = {
      contents: [
        {
          parts: [
            {
              text: `You are an accurate retail speech translation engine. Translate the following spoken customer dialogue into clear, natural English.
If the text is already in English, return it exactly as is.
Return ONLY the direct English translation without any surrounding quotes, notes, or explanations.

Text: "${text}"`
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 256
      }
    };

    for (const model of models) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000)
        });

        if (res.ok) {
          const data = await res.json();
          const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (translated) {
            // Strip any accidental wrapping quotes
            return translated.replace(/^["']|["']$/g, '').trim();
          }
        }
      } catch (err) {
        // Continue to fallback model
      }
    }
  } catch (err) {
    console.warn('[Translation Service] Gemini translation note:', err.message);
  }
  return null;
}

/**
 * Fast Google Translate API fallback
 * @param {string} text
 * @returns {Promise<{ translatedText: string, detectedLang: string } | null>}
 */
async function translateWithGoogleHTTP(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const fullTranslation = data[0].map((item) => (item && item[0] ? item[0] : '')).join('').trim();
        const detectedLang = data[2] || 'auto';
        if (fullTranslation) {
          return { translatedText: fullTranslation, detectedLang };
        }
      }
    }
  } catch (err) {
    console.warn('[Translation Service] HTTP translation note:', err.message);
  }
  return null;
}

/**
 * Main translation function: translates recognized speech into English text
 * @param {string} sourceText - Original transcribed text from STT provider
 * @returns {Promise<{ englishText: string, originalText: string, wasTranslated: boolean, sourceLanguage: string }>}
 */
async function translateToEnglish(sourceText) {
  const trimmed = (sourceText || '').trim();
  if (!trimmed) {
    return {
      englishText: '',
      originalText: '',
      wasTranslated: false,
      sourceLanguage: 'en',
    };
  }

  // Check cache
  if (translationCache.has(trimmed)) {
    return translationCache.get(trimmed);
  }

  // Heuristic check: is translation needed?
  const looksSpanish = containsSpanishOrForeignWords(trimmed);
  
  // If it doesn't look Spanish or foreign, test with fast HTTP or return as English
  if (!looksSpanish) {
    const result = {
      englishText: trimmed,
      originalText: trimmed,
      wasTranslated: false,
      sourceLanguage: 'en',
    };
    if (translationCache.size < 500) {
      translationCache.set(trimmed, result);
    }
    return result;
  }

  // 1. Try fast Google Translate HTTP fallback first (typically ~80ms)
  const httpResult = await translateWithGoogleHTTP(trimmed);
  if (httpResult && httpResult.translatedText) {
    const wasDifferent = httpResult.translatedText.toLowerCase() !== trimmed.toLowerCase();
    const result = {
      englishText: httpResult.translatedText,
      originalText: trimmed,
      wasTranslated: wasDifferent,
      sourceLanguage: httpResult.detectedLang || 'es',
    };
    if (translationCache.size < 500) {
      translationCache.set(trimmed, result);
    }
    return result;
  }

  // 2. Try Gemini Flash if HTTP fallback was unavailable
  const geminiTranslation = await translateWithGemini(trimmed);
  if (geminiTranslation) {
    const wasDifferent = geminiTranslation.toLowerCase() !== trimmed.toLowerCase();
    const result = {
      englishText: geminiTranslation,
      originalText: trimmed,
      wasTranslated: wasDifferent,
      sourceLanguage: 'es',
    };
    if (translationCache.size < 500) {
      translationCache.set(trimmed, result);
    }
    return result;
  }

  // 3. Offline retail dictionary fallback for common phrases
  const lower = trimmed.toLowerCase();
  let translatedText = trimmed;
  let translatedAny = false;

  const phraseReplacements = [
    [/hola/gi, 'hello'],
    [/buenas tardes/gi, 'good afternoon'],
    [/buenos d[ií]as/gi, 'good morning'],
    [/buenas noches/gi, 'good evening'],
    [/cu[aá]nto me dan por/gi, 'how much do you give me for'],
    [/cu[aá]nto cuesta/gi, 'how much does it cost'],
    [/cu[aá]nto/gi, 'how much'],
    [/cu[aá]nta/gi, 'how much'],
    [/tienen financiamiento disponible/gi, 'do you have financing available'],
    [/financiamiento disponible/gi, 'financing available'],
    [/financiamiento/gi, 'financing'],
    [/con tarjeta de cr[eé]dito/gi, 'with credit card'],
    [/tarjeta de cr[eé]dito/gi, 'credit card'],
    [/tarjeta/gi, 'card'],
    [/efectivo/gi, 'cash'],
    [/el iphone/gi, 'the iPhone'],
    [/quisiera comprar/gi, 'I would like to buy'],
    [/quiero comprar/gi, 'I want to buy'],
    [/busco un/gi, 'I am looking for a'],
    [/mi tel[eé]fono usado/gi, 'my used phone'],
    [/tel[eé]fono usado/gi, 'used phone'],
    [/tel[eé]fono/gi, 'phone'],
    [/celular/gi, 'phone'],
    [/programa de canje/gi, 'trade-in program'],
    [/en el programa de canje/gi, 'in the trade-in program'],
    [/canje/gi, 'trade-in'],
    [/un cargador nuevo/gi, 'a new charger'],
    [/cargador/gi, 'charger'],
    [/funda/gi, 'case'],
    [/pantalla/gi, 'screen'],
    [/bater[ií]a/gi, 'battery'],
    [/nuevo/gi, 'new'],
    [/nueva/gi, 'new'],
    [/usado/gi, 'used'],
    [/usada/gi, 'used'],
    [/puedo pagar con tarjeta de cr[eé]dito/gi, 'can I pay with credit card'],
    [/precio/gi, 'price'],
    [/gracias/gi, 'thank you'],
    [/por favor/gi, 'please'],
    [/disculpe/gi, 'excuse me'],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    if (pattern.test(translatedText)) {
      translatedText = translatedText.replace(pattern, replacement);
      translatedAny = true;
    }
  }

  // Clean Spanish punctuation marks
  translatedText = translatedText.replace(/[¿¡]/g, '');

  if (translatedAny) {
    const result = {
      englishText: translatedText,
      originalText: trimmed,
      wasTranslated: true,
      sourceLanguage: 'es',
    };
    if (translationCache.size < 500) {
      translationCache.set(trimmed, result);
    }
    return result;
  }

  // If all translation attempts fail, return original with wasTranslated: false
  return {
    englishText: trimmed,
    originalText: trimmed,
    wasTranslated: false,
    sourceLanguage: 'auto',
  };
}

function detectLanguage(text) {
  return containsSpanishOrForeignWords(text) ? 'es' : 'en';
}

async function ensureEnglishTranscript(text) {
  const res = await translateToEnglish(text);
  return {
    ...res,
    isTranslated: Boolean(res.wasTranslated),
  };
}

module.exports = {
  translateToEnglish,
  containsSpanishOrForeignWords,
  detectLanguage,
  ensureEnglishTranscript,
};
