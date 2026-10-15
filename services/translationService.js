/**
 * Storelistener — Spanish-to-English Speech Translation Pipeline (Module 4)
 * File: services/translationService.js
 *
 * Requirements:
 * 1. English speech: Keep in English exactly as recognized without rewriting or translation.
 * 2. Spanish speech: Detect Spanish speech and translate it into natural, accurate English.
 * 3. Any other language: Do NOT translate. Retain recognized text verbatim without guessing.
 * 4. Final transcript display: Language set to English for English and Spanish conversations.
 */

require('dotenv').config();

// In-memory translation cache to eliminate redundant network calls and prevent duplicate translations
const translationCache = new Map();

// Distinct Spanish indicators & common retail vocabulary
const SPANISH_DISTINCT = new Set([
  'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'gracias', 'favor',
  'cuanto', 'cuanta', 'cuantos', 'cuantas', 'cuesta', 'cuestan', 'precio', 'comprar', 'quisiera', 'quiero',
  'telefono', 'celular', 'pantalla', 'bateria', 'funda', 'cargador', 'cables', 'cable',
  'tarjeta', 'efectivo', 'pago', 'descuento', 'garantia', 'cambio', 'reparacion',
  'donde', 'como', 'cuando', 'quien', 'nuevo', 'nueva', 'nuevos', 'nuevas',
  'usado', 'usada', 'antiguo', 'modelo', 'color', 'negro', 'blanco', 'azul', 'rojo', 'verde',
  'senor', 'senora', 'amigo', 'tienen', 'tiene', 'puedo', 'puede', 'ayuda',
  'costo', 'vale', 'dinero', 'revisar', 'llevar', 'llevo', 'dame', 'estan', 'aqui',
  'alla', 'sobre', 'aquel', 'aquella', 'unos', 'unas', 'otro', 'otra', 'otros', 'otras',
  'mucho', 'muchas', 'pocos', 'pocas', 'bienvenido', 'bienvenidos', 'disculpe', 'perdon',
  'necesito', 'buscar', 'busco', 'rota', 'roto', 'arreglar', 'funciona', 'cambiar'
]);

// Contextual Spanish functional words
const SPANISH_GRAMMAR = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'para', 'con', 'por',
  'este', 'esta', 'estos', 'estas', 'esto', 'ese', 'esa', 'esos', 'esas', 'eso',
  'que', 'pero', 'muy', 'yo', 'tu', 'usted', 'ustedes', 'nosotros', 'ellos'
]);

// French distinct words and accents to avoid false-positive translation
const FRENCH_WORDS = new Set([
  'bonjour', 'merci', 'oui', 'non', 'sil', 'vous', 'plait', 'je', 'voudrais', 'combien', 'acheter', 'avec'
]);
const FRENCH_CHARS = /[èàçôêëœæÈÀÇÔÊË]/;

// Specific Spanish diacritics and punctuation
const SPANISH_CHARS = /[áéíóúñÁÉÍÓÚÑ¿¡]/;

// Non-Latin scripts (Hindi/Devanagari, Urdu/Arabic, Cyrillic, Chinese, Japanese, Korean, Gurmukhi, etc.)
const NON_LATIN_SCRIPTS = /[\u0900-\u097F\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u0A00-\u0A7F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

/**
 * Accurately detects whether a given transcript text is Spanish.
 * Returns false for English, French, Hindi, Urdu, or any other language.
 * @param {string} text
 * @returns {boolean}
 */
function isSpanishText(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 1. Immediately reject non-Latin scripts (Devanagari/Hindi, Urdu/Arabic, etc.)
  if (NON_LATIN_SCRIPTS.test(trimmed)) {
    return false;
  }

  // 2. Reject French accents
  if (FRENCH_CHARS.test(trimmed)) {
    return false;
  }

  // Normalize accents for dictionary lookup while preserving original text
  const normalized = trimmed.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = normalized.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  let frenchMatches = 0;
  let spanishDistinctMatches = 0;
  let spanishGrammarMatches = 0;

  for (const w of words) {
    if (FRENCH_WORDS.has(w)) frenchMatches++;
    if (SPANISH_DISTINCT.has(w)) spanishDistinctMatches++;
    if (SPANISH_GRAMMAR.has(w)) spanishGrammarMatches++;
  }

  // If French vocabulary is detected, do not translate
  if (frenchMatches > 0) return false;

  // Distinct Spanish words present (retail terms, greetings, questions)
  if (spanishDistinctMatches >= 1) return true;

  // Distinct Spanish diacritics present with Spanish structure
  if (SPANISH_CHARS.test(trimmed) && (spanishGrammarMatches >= 1 || words.length <= 4)) return true;

  // Multiple Spanish functional grammar words occurring together
  if (spanishGrammarMatches >= 2) return true;

  return false;
}

/**
 * Backward compatibility alias for isSpanishText
 */
const containsSpanishOrForeignWords = isSpanishText;

/**
 * Primary translation engine: MyMemory Translation API
 * Fast (~200ms), highly accurate for Spanish-to-English retail speech.
 * @param {string} text
 * @returns {Promise<string|null>}
 */
async function translateWithMyMemory(text) {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=es|en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      const raw = data?.responseData?.translatedText?.trim();
      if (raw && !raw.startsWith('MYMEMORY WARNING')) {
        const decoded = raw
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim();
        return decoded;
      }
    }
  } catch (err) {
    // Graceful fallback to next tier
  }
  return null;
}

/**
 * Secondary translation engine: Google Gemini API
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
              text: `You are an accurate retail speech translation engine. Translate the following spoken Spanish dialogue into natural, accurate English.
Return ONLY the direct English translation without any surrounding quotes, notes, or explanations.

Spanish: "${text}"`
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
          signal: AbortSignal.timeout(4000)
        });

        if (res.ok) {
          const data = await res.json();
          const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (translated) {
            return translated.replace(/^["']|["']$/g, '').trim();
          }
        }
      } catch (err) {
        // Fall through to next model
      }
    }
  } catch (err) {
    // Non-blocking
  }
  return null;
}

/**
 * Tertiary translation fallback: Google HTTP Translation
 * @param {string} text
 * @returns {Promise<string|null>}
 */
async function translateWithGoogleHTTP(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const fullTranslation = data[0].map((item) => (item && item[0] ? item[0] : '')).join('').trim();
        if (fullTranslation) {
          return fullTranslation;
        }
      }
    }
  } catch (err) {
    // Non-blocking
  }
  return null;
}

/**
 * Deterministic offline retail Spanish dictionary fallback
 * @param {string} text
 * @returns {string|null}
 */
function translateWithOfflineDictionary(text) {
  let translated = text;
  let changed = false;

  const phraseReplacements = [
    [/hola,?\s*buenas tardes/gi, 'hello, good afternoon'],
    [/hola,?\s*buenos d[ií]as/gi, 'hello, good morning'],
    [/hola,?\s*buenas noches/gi, 'hello, good evening'],
    [/buenas tardes/gi, 'good afternoon'],
    [/buenos d[ií]as/gi, 'good morning'],
    [/buenas noches/gi, 'good evening'],
    [/hola/gi, 'hello'],
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
    [/quisiera comprar/gi, 'I would like to buy'],
    [/quiero comprar/gi, 'I want to buy'],
    [/busco un/gi, 'I am looking for a'],
    [/busco una/gi, 'I am looking for a'],
    [/mi tel[eé]fono usado/gi, 'my used phone'],
    [/tel[eé]fono usado/gi, 'used phone'],
    [/tel[eé]fono/gi, 'phone'],
    [/celular/gi, 'phone'],
    [/programa de canje/gi, 'trade-in program'],
    [/en el programa de canje/gi, 'in the trade-in program'],
    [/canje/gi, 'trade-in'],
    [/un cargador nuevo/gi, 'a new charger'],
    [/cargador nuevo/gi, 'new charger'],
    [/cargador/gi, 'charger'],
    [/funda/gi, 'case'],
    [/pantalla rota/gi, 'broken screen'],
    [/pantalla/gi, 'screen'],
    [/bater[ií]a/gi, 'battery'],
    [/nuevo/gi, 'new'],
    [/nueva/gi, 'new'],
    [/usado/gi, 'used'],
    [/usada/gi, 'used'],
    [/puedo pagar con tarjeta de cr[eé]dito/gi, 'can I pay with credit card'],
    [/puedo pagar con tarjeta/gi, 'can I pay with card'],
    [/puedo pagar/gi, 'can I pay'],
    [/precio/gi, 'price'],
    [/gracias por la ayuda/gi, 'thank you for the help'],
    [/me lo llevo/gi, 'I will take it'],
    [/gracias/gi, 'thank you'],
    [/por favor/gi, 'please'],
    [/disculpe/gi, 'excuse me'],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    if (pattern.test(translated)) {
      translated = translated.replace(pattern, replacement);
      changed = true;
    }
  }

  // Clean Spanish punctuation marks
  translated = translated.replace(/[¿¡]/g, '').trim();

  return changed ? translated : null;
}

/**
 * Main translation function: translates recognized Spanish speech into clean English.
 * English speech and all other languages (Hindi, Urdu, French, etc.) are kept verbatim.
 *
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

  // Return cached result if already translated
  if (translationCache.has(trimmed)) {
    return translationCache.get(trimmed);
  }

  // Strictly check if recognized text is Spanish
  const isSpanish = isSpanishText(trimmed);

  // If NOT Spanish (English, Urdu, Hindi, French, or any other language):
  // Retain recognized text verbatim without applying translation
  if (!isSpanish) {
    const result = {
      englishText: trimmed,
      originalText: trimmed,
      wasTranslated: false,
      sourceLanguage: 'en',
    };
    if (translationCache.size < 1000) {
      translationCache.set(trimmed, result);
    }
    return result;
  }

  // Recognized source language is Spanish: translate into English
  let englishTranslation = null;

  // 1. Try MyMemory API (fastest & highly accurate)
  englishTranslation = await translateWithMyMemory(trimmed);

  // 2. Try Gemini Flash if MyMemory was unreachable
  if (!englishTranslation) {
    englishTranslation = await translateWithGemini(trimmed);
  }

  // 3. Try Google HTTP fallback
  if (!englishTranslation) {
    englishTranslation = await translateWithGoogleHTTP(trimmed);
  }

  // 4. Try offline retail dictionary
  if (!englishTranslation) {
    englishTranslation = translateWithOfflineDictionary(trimmed);
  }

  // Refine translated output with retail terminology (e.g. redemption program -> trade-in program)
  if (englishTranslation) {
    englishTranslation = englishTranslation
      .replace(/\bredemption program\b/gi, 'trade-in program')
      .replace(/\bredemption\b/gi, 'trade-in')
      .replace(/\bscreensaver\b/gi, 'screen protector')
      .replace(/\bscreen saver\b/gi, 'screen protector');
  }

  const finalEnglish = englishTranslation || trimmed;
  const wasDifferent = finalEnglish.toLowerCase().trim() !== trimmed.toLowerCase().trim();

  const result = {
    englishText: finalEnglish,
    originalText: trimmed,
    wasTranslated: wasDifferent,
    sourceLanguage: 'es',
  };

  if (translationCache.size < 1000) {
    translationCache.set(trimmed, result);
  }

  return result;
}

/**
 * Detect language: returns 'es' for Spanish speech, 'en' otherwise.
 * @param {string} text
 * @returns {string}
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'en';
  return isSpanishText(text) ? 'es' : 'en';
}

/**
 * Ensures transcript text has an English representation
 * @param {string} text
 * @returns {Promise<{ englishText: string, originalText: string, isTranslated: boolean, sourceLanguage: string }>}
 */
async function ensureEnglishTranscript(text) {
  const res = await translateToEnglish(text);
  return {
    ...res,
    isTranslated: Boolean(res.wasTranslated),
  };
}

module.exports = {
  isSpanishText,
  containsSpanishOrForeignWords,
  translateToEnglish,
  detectLanguage,
  ensureEnglishTranscript,
};
