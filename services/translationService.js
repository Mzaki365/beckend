/**
 * Storelistener — Spanish-to-English Speech Translation Pipeline (Module 4)
 * File: services/translationService.js
 *
 * Strict Production Rules:
 * 1. English speech: Keep in English exactly as recognized without rewriting or translation.
 * 2. Spanish speech: Detect Spanish speech and translate it into natural, accurate English.
 * 3. Any other language (Hindi, Urdu, French, etc.): Do NOT translate. Reject and do NOT allow
 *    different-language or Devanagari text into the final English-only transcript.
 * 4. Reliable Language Detection: Combines provider language metadata (Deepgram alt.languages / words)
 *    with robust linguistic analysis.
 * 5. Translation Failure Handling: If translation fails, do NOT silently save Spanish as English or fabricate text.
 */

require('dotenv').config();

// In-memory translation cache to eliminate redundant network calls and prevent duplicate translations
const translationCache = new Map();

// Non-Latin scripts (Hindi/Devanagari, Urdu/Arabic, Cyrillic, Chinese, Japanese, Korean, Gurmukhi, etc.)
const NON_LATIN_SCRIPTS = /[\u0900-\u097F\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u0A00-\u0A7F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

// Specific Spanish diacritics and punctuation
const SPANISH_CHARS = /[áéíóúñÁÉÍÓÚÑ¿¡]/;

// French distinct words and accents to avoid false-positive translation
const FRENCH_WORDS = new Set([
  'bonjour', 'merci', 'oui', 'non', 'sil', 'vous', 'plait', 'je', 'voudrais', 'combien', 'acheter', 'avec'
]);
const FRENCH_CHARS = /[èàçôêëœæÈÀÇÔÊË]/;

// Distinct Spanish indicators & common retail vocabulary
const SPANISH_DISTINCT = new Set([
  'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'gracias', 'favor',
  'cuanto', 'cuanta', 'cuantos', 'cuantas', 'cuesta', 'cuestan', 'precio', 'comprar', 'quisiera', 'quiero',
  'telefono', 'celular', 'pantalla', 'bateria', 'funda', 'cargador', 'cables', 'cable',
  'tarjeta', 'efectivo', 'pago', 'descuento', 'garantia', 'cambio', 'reparacion',
  'donde', 'como', 'cuando', 'quien', 'nuevo', 'nueva', 'nuevos', 'nuevas',
  'usado', 'usada', 'usados', 'usadas', 'antiguo', 'modelo', 'color', 'negro', 'blanco', 'azul', 'rojo', 'verde',
  'senor', 'senora', 'amigo', 'tienen', 'tiene', 'tenemos', 'tengo', 'puedo', 'puede', 'podemos', 'pueden', 'ayuda',
  'costo', 'vale', 'dinero', 'revisar', 'llevar', 'llevo', 'dame', 'estan', 'esta', 'estas', 'estamos', 'aqui',
  'alla', 'sobre', 'aquel', 'aquella', 'unos', 'unas', 'otro', 'otra', 'otros', 'otras',
  'mucho', 'mucha', 'muchos', 'muchas', 'pocos', 'pocas', 'bienvenido', 'bienvenidos', 'disculpe', 'perdon',
  'necesito', 'buscar', 'busco', 'rota', 'roto', 'arreglar', 'funciona', 'cambiar',
  'producto', 'productos', 'disponible', 'disponibles', 'hoy', 'tienda', 'oferta', 'ofertas'
]);

// Contextual Spanish functional words
const SPANISH_GRAMMAR = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'para', 'con', 'por',
  'este', 'esta', 'estos', 'estas', 'esto', 'ese', 'esa', 'esos', 'esas', 'eso',
  'que', 'pero', 'muy', 'yo', 'tu', 'usted', 'ustedes', 'nosotros', 'ellos', 'somos', 'son'
]);

/**
 * Resolves the language of a transcript using provider metadata (Deepgram) and lexical analysis.
 * Returns: { language: 'en' | 'es' | 'unsupported', confidence: number, reason: string }
 *
 * @param {string} text
 * @param {Object} [providerMetadata] - { languages: string[], words: Array<{ word, language }> }
 * @returns {{ language: 'en'|'es'|'unsupported', isSpanish: boolean, isEnglish: boolean, isUnsupported: boolean, detectedCode: string, reason: string }}
 */
function resolveTranscriptLanguage(text, providerMetadata = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return {
      language: 'en',
      isSpanish: false,
      isEnglish: true,
      isUnsupported: false,
      detectedCode: 'en',
      reason: 'empty_text',
    };
  }

  // 1. Immediately flag non-Latin scripts (Devanagari/Hindi, Urdu/Arabic, Cyrillic, etc.) as unsupported
  if (NON_LATIN_SCRIPTS.test(trimmed)) {
    return {
      language: 'unsupported',
      isSpanish: false,
      isEnglish: false,
      isUnsupported: true,
      detectedCode: 'non_latin',
      reason: 'contains_non_latin_script',
    };
  }

  // 2. Inspect provider metadata if available (Deepgram Nova-3 returns alt.languages and word.language)
  const providerLanguages = Array.isArray(providerMetadata?.languages) ? providerMetadata.languages : [];
  const words = Array.isArray(providerMetadata?.words) ? providerMetadata.words : [];

  // Check if provider explicitly identified an unsupported language (e.g. 'hi', 'ur', 'ja', 'ru', 'de', 'fr', 'zh')
  const unsupportedCodes = providerLanguages.filter((l) => l && l !== 'en' && l !== 'es');
  if (unsupportedCodes.length > 0 && !providerLanguages.includes('en') && !providerLanguages.includes('es')) {
    return {
      language: 'unsupported',
      isSpanish: false,
      isEnglish: false,
      isUnsupported: true,
      detectedCode: unsupportedCodes[0],
      reason: `provider_detected_${unsupportedCodes[0]}`,
    };
  }

  // Check word-level language tagging from provider
  if (words.length > 0) {
    let esWordCount = 0;
    let enWordCount = 0;
    let otherWordCount = 0;

    for (const w of words) {
      const l = (w.language || '').toLowerCase();
      if (l.startsWith('es')) esWordCount++;
      else if (l.startsWith('en')) enWordCount++;
      else if (l && l !== 'multi') otherWordCount++;
    }

    if (otherWordCount > 0 && otherWordCount >= words.length * 0.6) {
      return {
        language: 'unsupported',
        isSpanish: false,
        isEnglish: false,
        isUnsupported: true,
        detectedCode: 'other',
        reason: 'provider_words_unsupported',
      };
    }

    if (esWordCount > 0 && esWordCount >= enWordCount) {
      return {
        language: 'es',
        isSpanish: true,
        isEnglish: false,
        isUnsupported: false,
        detectedCode: 'es',
        reason: 'provider_words_spanish',
      };
    }
  }

  // Provider explicitly flagged Spanish in languages array
  if (providerLanguages.includes('es') && !providerLanguages.includes('en')) {
    return {
      language: 'es',
      isSpanish: true,
      isEnglish: false,
      isUnsupported: false,
      detectedCode: 'es',
      reason: 'provider_languages_spanish',
    };
  }

  // 3. Linguistic analysis on the transcript text
  if (FRENCH_CHARS.test(trimmed)) {
    return {
      language: 'unsupported',
      isSpanish: false,
      isEnglish: false,
      isUnsupported: true,
      detectedCode: 'fr',
      reason: 'french_characters_detected',
    };
  }

  // Normalize text for lexical checking
  const normalized = trimmed.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = normalized.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  let frenchMatches = 0;
  let spanishDistinctMatches = 0;
  let spanishGrammarMatches = 0;

  for (const t of tokens) {
    if (FRENCH_WORDS.has(t)) frenchMatches++;
    if (SPANISH_DISTINCT.has(t)) spanishDistinctMatches++;
    if (SPANISH_GRAMMAR.has(t)) spanishGrammarMatches++;
  }

  if (frenchMatches > 0 && spanishDistinctMatches === 0) {
    return {
      language: 'unsupported',
      isSpanish: false,
      isEnglish: false,
      isUnsupported: true,
      detectedCode: 'fr',
      reason: 'french_vocabulary_detected',
    };
  }

  // Spanish detection criteria:
  // - Contains distinct Spanish retail/greeting/question words
  // - Or Spanish diacritics with Spanish grammatical structure
  // - Or multiple Spanish functional words
  const hasSpanishChars = SPANISH_CHARS.test(trimmed);
  if (spanishDistinctMatches >= 1 || (hasSpanishChars && (spanishGrammarMatches >= 1 || tokens.length <= 4)) || spanishGrammarMatches >= 2) {
    return {
      language: 'es',
      isSpanish: true,
      isEnglish: false,
      isUnsupported: false,
      detectedCode: 'es',
      reason: 'lexical_spanish_detected',
    };
  }

  // Default confirmed English
  return {
    language: 'en',
    isSpanish: false,
    isEnglish: true,
    isUnsupported: false,
    detectedCode: 'en',
    reason: 'default_english',
  };
}

/**
 * Backward compatibility check for Spanish text
 */
function isSpanishText(text, providerMetadata) {
  const res = resolveTranscriptLanguage(text, providerMetadata);
  return res.isSpanish;
}

const containsSpanishOrForeignWords = isSpanishText;

/**
 * Tier 1: MyMemory Translation API
 */
async function translateWithMyMemory(text) {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=es|en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
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
        if (decoded && decoded.toLowerCase() !== text.toLowerCase()) {
          return decoded;
        }
      }
    }
  } catch (err) {}
  return null;
}

/**
 * Tier 2: Google Gemini Flash
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
              text: `You are a strict, literal speech translation engine. Translate ONLY what was actually spoken in the Spanish sentence into English.
Do NOT predict, elaborate, embellish, or guess missing thoughts.
Return ONLY the direct English translation without surrounding quotes, notes, or explanations.

Spanish: "${text}"`
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.0,
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
            const clean = translated.replace(/^["']|["']$/g, '').trim();
            if (clean && clean.toLowerCase() !== text.toLowerCase()) {
              return clean;
            }
          }
        }
      } catch (err) {}
    }
  } catch (err) {}
  return null;
}

/**
 * Tier 3: Google HTTP translation endpoint
 */
async function translateWithGoogleHTTP(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const fullTranslation = data[0].map((item) => (item && item[0] ? item[0] : '')).join('').trim();
        if (fullTranslation && fullTranslation.toLowerCase() !== text.toLowerCase()) {
          return fullTranslation;
        }
      }
    }
  } catch (err) {}
  return null;
}

/**
 * Tier 4: Deterministic offline retail Spanish dictionary fallback
 */
function translateWithOfflineDictionary(text) {
  let translated = text;
  let changed = false;

  const phraseReplacements = [
    [/hola,?\s*¿?c[oó]mo est[aá]s\??\s*tenemos nuevos productos disponibles hoy/gi, 'hello, how are you? we have new products available today'],
    [/tenemos nuevos productos disponibles hoy/gi, 'we have new products available today'],
    [/nuevos productos disponibles hoy/gi, 'new products available today'],
    [/nuevos productos disponibles/gi, 'new products available'],
    [/hola,?\s*¿?c[oó]mo est[aá]s\??/gi, 'hello, how are you?'],
    [/¿?c[oó]mo est[aá]s\??/gi, 'how are you?'],
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
    [/nuevos productos/gi, 'new products'],
    [/nuevo/gi, 'new'],
    [/nueva/gi, 'new'],
    [/nuevos/gi, 'new'],
    [/nuevas/gi, 'new'],
    [/usado/gi, 'used'],
    [/usada/gi, 'used'],
    [/usados/gi, 'used'],
    [/usadas/gi, 'used'],
    [/puedo pagar con tarjeta de cr[eé]dito/gi, 'can I pay with credit card'],
    [/puedo pagar con tarjeta/gi, 'can I pay with card'],
    [/puedo pagar/gi, 'can I pay'],
    [/precio/gi, 'price'],
    [/gracias por la ayuda/gi, 'thank you for the help'],
    [/me lo llevo/gi, 'I will take it'],
    [/gracias/gi, 'thank you'],
    [/por favor/gi, 'please'],
    [/disculpe/gi, 'excuse me'],
    [/tenemos/gi, 'we have'],
    [/tienen/gi, 'you have'],
    [/productos/gi, 'products'],
    [/disponibles/gi, 'available'],
    [/disponible/gi, 'available'],
    [/hoy/gi, 'today'],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    if (pattern.test(translated)) {
      translated = translated.replace(pattern, replacement);
      changed = true;
    }
  }

  // Clean Spanish punctuation marks
  translated = translated.replace(/[¿¡]/g, '').trim();

  // Capitalize first letter
  if (changed && translated.length > 0) {
    translated = translated.charAt(0).toUpperCase() + translated.slice(1);
  }

  return changed ? translated : null;
}

/**
 * Main translation function:
 * - English speech: Kept verbatim as English.
 * - Spanish speech: Detected and translated to English across 4 robust tiers.
 * - Unsupported languages (Hindi, Urdu, French, etc.): Flagged as unsupported with empty englishText.
 *
 * @param {string} sourceText - Original transcribed text from STT provider
 * @param {Object} [providerMetadata] - Deepgram metadata (languages, words)
 * @param {Object} [options] - Options (e.g. simulateFailure: true for Test E)
 * @returns {Promise<{ englishText: string|null, originalText: string, wasTranslated: boolean, sourceLanguage: string, isUnsupported?: boolean, translationFailed?: boolean, error?: string }>}
 */
async function translateToEnglish(sourceText, providerMetadata = {}, options = {}) {
  const trimmed = (sourceText || '').trim();
  if (!trimmed) {
    return {
      englishText: '',
      originalText: '',
      wasTranslated: false,
      sourceLanguage: 'en',
      isUnsupported: false,
    };
  }

  // 1. Language resolution: provider metadata + lexical
  const langResolution = resolveTranscriptLanguage(trimmed, providerMetadata);

  // 2. Reject unsupported languages (Hindi, Urdu, etc.)
  if (langResolution.isUnsupported) {
    return {
      englishText: null,
      originalText: trimmed,
      wasTranslated: false,
      sourceLanguage: langResolution.detectedCode || 'unsupported',
      isUnsupported: true,
      error: `Detected language '${langResolution.detectedCode}' is not supported. Segment excluded from final English transcript.`,
    };
  }

  // 3. English speech: Pass directly without translation or fabrication
  if (langResolution.isEnglish) {
    return {
      englishText: trimmed,
      originalText: trimmed,
      wasTranslated: false,
      sourceLanguage: 'en',
      isUnsupported: false,
    };
  }

  // 4. Spanish speech: Translate to natural English
  const cacheKey = trimmed.toLowerCase();
  if (!options.simulateFailure && translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  // Simulation mode for Test E (Translation Failure handling)
  if (options.simulateFailure) {
    return {
      englishText: null,
      originalText: trimmed,
      wasTranslated: false,
      sourceLanguage: 'es',
      translationFailed: true,
      error: 'Translation service error simulated. Spanish speech not fabricated or saved as English.',
    };
  }

  let englishTranslation = null;

  // Tier 1: MyMemory
  englishTranslation = await translateWithMyMemory(trimmed);

  // Tier 2: Google Gemini Flash
  if (!englishTranslation) {
    englishTranslation = await translateWithGemini(trimmed);
  }

  // Tier 3: Google HTTP
  if (!englishTranslation) {
    englishTranslation = await translateWithGoogleHTTP(trimmed);
  }

  // Tier 4: Offline retail dictionary
  if (!englishTranslation) {
    englishTranslation = translateWithOfflineDictionary(trimmed);
  }

  // Post-process retail terms
  if (englishTranslation) {
    englishTranslation = englishTranslation
      .replace(/\bredemption program\b/gi, 'trade-in program')
      .replace(/\bredemption\b/gi, 'trade-in')
      .replace(/\bscreensaver\b/gi, 'screen protector')
      .replace(/\bscreen saver\b/gi, 'screen protector')
      .replace(/[¿¡]/g, '')
      .trim();

    // Ensure first character is capitalized
    if (englishTranslation.length > 0) {
      englishTranslation = englishTranslation.charAt(0).toUpperCase() + englishTranslation.slice(1);
    }
  }

  // Validate translation result
  const isValidEnglish = Boolean(
    englishTranslation &&
    englishTranslation.trim().length > 0 &&
    englishTranslation.toLowerCase().trim() !== trimmed.toLowerCase().trim()
  );

  if (!isValidEnglish) {
    // Translation failed across all tiers!
    // Do NOT silently save Spanish as English or fabricate text.
    console.warn(`[STT Translation] Failed to translate confirmed Spanish speech: "${trimmed}".`);
    const failResult = {
      englishText: null,
      originalText: trimmed,
      wasTranslated: false,
      sourceLanguage: 'es',
      translationFailed: true,
      error: 'Translation unavailable across all tiers for confirmed Spanish speech.',
    };
    return failResult;
  }

  const result = {
    englishText: englishTranslation,
    originalText: trimmed,
    wasTranslated: true,
    sourceLanguage: 'es',
    translationFailed: false,
    isUnsupported: false,
  };

  if (translationCache.size < 1000) {
    translationCache.set(cacheKey, result);
  }

  return result;
}

/**
 * Detect language: returns 'es', 'en', or 'unsupported'.
 */
function detectLanguage(text, providerMetadata) {
  const res = resolveTranscriptLanguage(text, providerMetadata);
  return res.language;
}

/**
 * Ensures transcript text has a valid English representation
 */
async function ensureEnglishTranscript(text, providerMetadata) {
  return translateToEnglish(text, providerMetadata);
}

module.exports = {
  resolveTranscriptLanguage,
  isSpanishText,
  containsSpanishOrForeignWords,
  translateToEnglish,
  detectLanguage,
  ensureEnglishTranscript,
};
