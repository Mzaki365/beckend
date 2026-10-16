/**
 * Storelistener Backend — Multilingual Translation Pipeline Tests
 * File: test/translation.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { translateToEnglish, resolveTranscriptLanguage, containsSpanishOrForeignWords } = require('../services/translationService');

describe('Backend Multilingual Speech Translation Engine', () => {
  test('Correctly identifies Spanish sentences requiring translation', () => {
    assert.equal(containsSpanishOrForeignWords('Hola, buenos días'), true);
    assert.equal(containsSpanishOrForeignWords('¿Cuánto cuesta el teléfono?'), true);
    assert.equal(containsSpanishOrForeignWords('Quisiera comprar un cargador nuevo'), true);
    assert.equal(containsSpanishOrForeignWords('Puedo pagar con tarjeta de crédito'), true);
    assert.equal(containsSpanishOrForeignWords('Hola, ¿cómo estás? Tenemos nuevos productos disponibles hoy.'), true);
  });

  test('Correctly identifies standard English sentences without triggering false positives', () => {
    assert.equal(containsSpanishOrForeignWords('Hello, how much is the iPhone 16 Pro?'), false);
    assert.equal(containsSpanishOrForeignWords('I would like to trade in my old device'), false);
    assert.equal(containsSpanishOrForeignWords('Is AppleCare warranty included?'), false);
    assert.equal(containsSpanishOrForeignWords('Hello, how are you? We have new products available today.'), false);
  });

  test('Mandatory Test A — English: Accurate English transcript without translation or other language', async () => {
    const input = 'Hello, how are you? We have new products available today.';
    const res = await translateToEnglish(input);
    assert.ok(res);
    assert.equal(res.wasTranslated, false);
    assert.equal(res.sourceLanguage, 'en');
    assert.equal(res.englishText, input);
    assert.equal(res.isUnsupported, false);
  });

  test('Mandatory Test B — Spanish: Accurate English translation for Spanish speech', async () => {
    const input = 'Hola, ¿cómo estás? Tenemos nuevos productos disponibles hoy.';
    const res = await translateToEnglish(input);
    assert.ok(res);
    assert.equal(res.wasTranslated, true);
    assert.equal(res.sourceLanguage, 'es');
    assert.equal(res.isUnsupported, false);
    assert.equal(res.translationFailed, false);
    const engLower = res.englishText.toLowerCase();
    assert.ok(engLower.includes('how are you'), `Expected 'how are you' in: ${res.englishText}`);
    assert.ok(engLower.includes('new products available today') || engLower.includes('products available'), `Expected retail phrase in: ${res.englishText}`);
  });

  test('Mandatory Test C — Repeated Speech & Rejection of Hindi/Unsupported Noise', async () => {
    // English sentence
    const sentEnglish = await translateToEnglish('Hello, how are you? We have new products available today.');
    assert.equal(sentEnglish.wasTranslated, false);
    assert.equal(sentEnglish.englishText, 'Hello, how are you? We have new products available today.');

    // Spanish sentence
    const sentSpanish = await translateToEnglish('Hola, ¿cómo estás? Tenemos nuevos productos disponibles hoy.');
    assert.equal(sentSpanish.wasTranslated, true);
    assert.ok(sentSpanish.englishText.toLowerCase().includes('how are you'));

    // Hindi/Devanagari misclassification or ambient noise
    const hindiInput = 'आपके account में';
    const sentHindi = await translateToEnglish(hindiInput, { languages: ['hi'], words: [{ word: 'में', language: 'hi' }] });
    assert.equal(sentHindi.isUnsupported, true);
    assert.equal(sentHindi.englishText, null);
    assert.ok(sentHindi.sourceLanguage !== 'en');
  });

  test('Mandatory Test E — Translation Failure: Does not silently save Spanish as English or fabricate text', async () => {
    const spanishInput = 'Hola, ¿cómo estás? Tenemos nuevos productos disponibles hoy.';
    const res = await translateToEnglish(spanishInput, {}, { simulateFailure: true });
    assert.ok(res);
    assert.equal(res.wasTranslated, false);
    assert.equal(res.sourceLanguage, 'es');
    assert.equal(res.translationFailed, true);
    assert.equal(res.englishText, null, 'Must NOT set englishText to Spanish when translation fails');
    assert.equal(res.originalText, spanishInput);
  });
});
