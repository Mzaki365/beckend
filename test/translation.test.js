/**
 * Storelistener Backend — Multilingual Translation Pipeline Tests
 * File: test/translation.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { translateToEnglish, containsSpanishOrForeignWords } = require('../services/translationService');

describe('Backend Multilingual Speech Translation Engine', () => {
  test('Correctly identifies Spanish sentences requiring translation', () => {
    assert.equal(containsSpanishOrForeignWords('Hola, buenos días'), true);
    assert.equal(containsSpanishOrForeignWords('¿Cuánto cuesta el teléfono?'), true);
    assert.equal(containsSpanishOrForeignWords('Quisiera comprar un cargador nuevo'), true);
    assert.equal(containsSpanishOrForeignWords('Puedo pagar con tarjeta de crédito'), true);
  });

  test('Correctly identifies standard English sentences without triggering false positives', () => {
    assert.equal(containsSpanishOrForeignWords('Hello, how much is the iPhone 16 Pro?'), false);
    assert.equal(containsSpanishOrForeignWords('I would like to trade in my old device'), false);
    assert.equal(containsSpanishOrForeignWords('Is AppleCare warranty included?'), false);
  });

  test('Translates Spanish retail phrases to English while preserving meaning', async () => {
    const res = await translateToEnglish('Hola, cuánto cuesta el iPhone');
    assert.ok(res);
    assert.equal(res.wasTranslated, true);
    assert.ok(res.englishText.toLowerCase().includes('iphone') || res.englishText.toLowerCase().includes('cost') || res.englishText.toLowerCase().includes('how much'));
  });

  test('Passes English sentences through directly without translating', async () => {
    const res = await translateToEnglish('Welcome to the store, how can I assist you?');
    assert.ok(res);
    assert.equal(res.wasTranslated, false);
    assert.equal(res.englishText, 'Welcome to the store, how can I assist you?');
  });
});
