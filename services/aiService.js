// services/aiService.js - Storelistener Real-time & Post-call AI Engine

// Known iPhone catalog & accessories
// Known iPhone catalog & accessories (English + Urdu + Punjabi)
const PRODUCT_KEYWORDS = [
  { name: 'iPhone 16 Pro Max', matches: ['16 pro max', 'sixteen pro max', '16 pro-max', 'آئی فون 16 پرو میکس', 'سولہ پرو میکس', 'solah pro max', 'iphone 16 pro max'] },
  { name: 'iPhone 16 Pro', matches: ['16 pro', 'sixteen pro', 'آئی فون 16 پرو', 'سولہ پرو', 'solah pro'] },
  { name: 'iPhone 16 Plus', matches: ['16 plus', 'sixteen plus', 'آئی فون 16 پلس', 'سولہ پلس'] },
  { name: 'iPhone 16', matches: ['iphone 16', 'standard 16', 'sixteen', 'آئی فون 16', 'سولہ'] },
  { name: 'iPhone 15 Pro Max', matches: ['15 pro max', 'fifteen pro max', 'آئی فون 15 پرو میکس', 'پندرہ پرو میکس'] },
  { name: 'iPhone 15 Pro', matches: ['15 pro', 'fifteen pro', 'آئی فون 15 پرو'] },
  { name: 'iPhone 15', matches: ['iphone 15', 'fifteen', 'آئی فون 15', 'پندرہ'] },
  { name: 'iPhone 14', matches: ['iphone 14', 'fourteen', 'آئی فون 14', 'چودہ'] },
  { name: 'iPhone 13', matches: ['iphone 13', 'thirteen', 'آئی فون 13', 'تیرہ'] },
  { name: 'AppleCare+ / Warranty', matches: ['apple care', 'applecare', 'warranty', 'accidental damage', 'وارنٹی', 'وارنٹی ملے گی', 'screen guarantee'] },
  { name: 'AirPods Pro 2', matches: ['airpods pro', 'airpods', 'earbuds', 'noise cancelling', 'ایئر پوڈز', 'ایئربڈز'] },
  { name: 'Apple Watch Series 10 / Ultra', matches: ['apple watch', 'watch ultra', 'smartwatch', 'series 10', 'گھڑی', 'ایپل واچ'] },
  { name: 'MagSafe & Charger', matches: ['magsafe', 'charger', 'adapter', '20w', 'type-c cable', 'case', 'screen protector', 'tempered glass', 'چارجر', 'کور', 'گلاس'] },
  { name: 'Trade-in / Exchange', matches: ['trade in', 'trade-in', 'exchange old phone', 'valuation', 'swap', 'پرانا فون', 'ایکسچینج', 'بدل کر'] }
];

const CLOSING_PHRASES = [
  // English
  'ill take it', "i'll take it", 'ill buy it', "i'll buy it",
  'wrap it up', 'ring it up', 'pay by card', 'card payment',
  'credit card', 'debit card', 'cash', 'apple pay',
  'heres my card', "here's my card", 'where do i sign', 'ready to pay',
  'heres the receipt', "here's the receipt", 'receipt', 'invoice',
  'invoice is ready', 'swipe your card', 'insert your card',
  'congratulations on your new iphone', 'bag this up', 'deal done',
  'deal is closed', 'sold', 'heres your new phone', 'payment successful',
  'paid in full', 'installment approved', 'finance approved',
  // Urdu & Roman Urdu
  'لے لو', 'لے لوں گا', 'میں لے رہا ہوں', 'پیک کر دو', 'کارڈ سے پیمنٹ', 
  'کیش دے رہا ہوں', 'بل بنا دو', 'رسید دے دیں', 'فائنل کرو', 'ڈن کرو', 
  'پیمنٹ ہو گئی', 'لے جاؤں گا', 'یہ ٹھیک ہے لے لیتا ہوں', 'کارڈ سوائپ کرو',
  'mai le raha hu', 'mai le lunga', 'pack kar do', 'bill bana do', 
  'card se payment', 'cash de raha hu', 'final karo', 'done karo', 
  'payment ho gai', 'le jao ga', 'deal done', 'bohat acha hai le leta hu', 
  'kar do pack', 'bill bna do', 'card swipe karo',
  // Punjabi
  'لے لو جی', 'پیک کر دیو', 'بل بنا دیو', 'پیسے دے دتے', 'فائنل کرو جی', 'لے لیندے آں',
  'main lae reha wan', 'pack kar deo', 'bill bana deo', 'paise de ditte', 
  'final karo ji', 'lai lainde aan', 'theek hai le lo'
];

const OBJECTION_PHRASES = [
  { 
    type: 'Price / Budget', 
    matches: [
      'too expensive', 'over my budget', 'high price', 'costly', 'out of reach', 'cheaper option', 'discount',
      'بہت مہنگا ہے', 'مہنگا ہے', 'بجٹ سے باہر', 'تھوڑا ڈسکاؤنٹ کرو', 'رعایت کرو', 'کم کرو',
      'bohat mehnga hai', 'mehnga hai', 'budget se bahir', 'discount karo', 'kuch kam karo', 'thora ghat karo'
    ] 
  },
  { 
    type: 'Trade-in Value', 
    matches: [
      'trade in value is low', 'low trade in', 'expected more for my old phone', 'lowball',
      'پرانے فون کی قیمت کم ہے', 'purane phone ki qeemat kam hai'
    ] 
  },
  { 
    type: 'Hesitation / Need to think', 
    matches: [
      'need to think', 'come back later', 'talk to my wife', 'talk to my husband', 'consult', 'sleep on it', 'just looking',
      'سوچ کے بتاتا ہوں', 'بعد میں آؤں گا', 'گھر پوچھ کے بتاؤں گا', 'ابھی صرف دیکھ رہا ہوں',
      'soch k batata hu', 'baad me aunga', 'soch lene do', 'phir aunga', 'sirf dekh raha hu'
    ] 
  },
  { 
    type: 'Storage / Specs', 
    matches: [
      'not enough storage', 'is 128gb enough', 'camera difference', 'battery life',
      'میموری کم ہے', 'کیمرہ کیسا ہے', 'بیٹری لائف', 'memory kam hai', 'camera kaisa hai'
    ] 
  },
  { 
    type: 'Color / Stock', 
    matches: [
      'out of stock', 'do you have desert titanium', 'wanted black titanium', 'natural titanium',
      'رنگ کون سا ہے', 'اسٹاک میں نہیں ہے', 'color konsa hai', 'stock me hai'
    ] 
  }
];

const COPILOT_SUGGESTIONS = [
  { trigger: 'price', suggestion: '💡 Suggest 0% APR 24-month financing ($45/mo) or check eligible carrier trade-in credits.' },
  { trigger: 'expensive', suggestion: '💡 Offer Apple Trade-in program to instantly slash up to $400 off the retail price.' },
  { trigger: 'storage', suggestion: '💡 Explain 4K ProRes video & Photos storage; recommend 256GB for long-term resale value.' },
  { trigger: 'applecare', suggestion: '💡 Mention theft & loss coverage + instant express screen replacement.' },
  { trigger: 'protect', suggestion: '💡 Bundle MagSafe silicone case + 20W USB-C adapter at 15% promotional discount.' },
  { trigger: 'think about it', suggestion: '💡 Ask: "What specific spec or price point can I clarify before you leave today?"' },
  { trigger: 'camera', suggestion: '💡 Highlight 48MP Fusion Camera, Camera Control button, and 5x optical telephoto zoom.' },
  { trigger: 'مہنگا', suggestion: '💡 اردو گائیڈ: کسٹمر کو انسٹالمنٹ پلان اور پرانے فون کے ایکسچینج بونس کی آفر دیں۔' },
  { trigger: 'mehnga', suggestion: '💡 Guide: Offer installment plan and trade-in discount on old device.' },
  { trigger: 'ڈسکاؤنٹ', suggestion: '💡 20W فاسٹ چارجر یا میگ سیف کور پر اسپیشل 15% رعایت کی پیشکش کریں۔' }
];

/**
 * Real-time fast inspection of a newly uttered transcript chunk
 */
function analyzeRealtimeChunk(chunkText, conversationHistory = []) {
  const lower = (chunkText || '').toLowerCase();
  
  // 1. Check for deal closure signal
  let isClosingSignal = false;
  let closingMatch = null;
  for (const phrase of CLOSING_PHRASES) {
    if (lower.includes(phrase)) {
      isClosingSignal = true;
      closingMatch = phrase;
      break;
    }
  }

  // 2. Check for objections
  let detectedObjection = null;
  for (const obj of OBJECTION_PHRASES) {
    if (obj.matches.some(m => lower.includes(m))) {
      detectedObjection = obj.type;
      break;
    }
  }

  // 3. Check for mentioned products
  const detectedProducts = [];
  for (const prod of PRODUCT_KEYWORDS) {
    if (prod.matches.some(m => lower.includes(m))) {
      detectedProducts.push(prod.name);
    }
  }

  // 4. Copilot suggestion
  let copilotTip = null;
  for (const item of COPILOT_SUGGESTIONS) {
    if (lower.includes(item.trigger)) {
      copilotTip = item.suggestion;
      break;
    }
  }

  // Calculate live probability
  const fullText = (conversationHistory.map(c => c.text).join(' ') + ' ' + lower).toLowerCase();
  let probability = 45;
  if (isClosingSignal) probability = 95;
  else {
    if (fullText.includes('financing') || fullText.includes('trade in') || fullText.includes('color')) probability += 15;
    if (fullText.includes('warranty') || fullText.includes('applecare')) probability += 15;
    if (fullText.includes('too expensive') || fullText.includes('just looking')) probability -= 20;
    if (fullText.includes('ill buy') || fullText.includes('take it')) probability = 90;
  }
  probability = Math.max(10, Math.min(99, probability));

  return {
    isClosingSignal,
    closingMatch,
    detectedObjection,
    detectedProducts,
    copilotTip,
    probability
  };
}

/**
 * Comprehensive post-conversation analytics
 */
async function generateFullAnalysis(transcripts = [], metadata = {}) {
  const fullText = transcripts.map(t => `${t.speaker.toUpperCase()}: ${t.text}`).join('\n');
  const lower = fullText.toLowerCase();

  // Determine detected devices
  const devicesDiscussed = [];
  for (const prod of PRODUCT_KEYWORDS) {
    if (prod.matches.some(m => lower.includes(m))) {
      devicesDiscussed.push(prod.name);
    }
  }

  // Determine objections
  const objections = [];
  for (const obj of OBJECTION_PHRASES) {
    if (obj.matches.some(m => lower.includes(m))) {
      objections.push(obj.type);
    }
  }

  // Determine closing signals
  const closingSignals = [];
  for (const phrase of CLOSING_PHRASES) {
    if (lower.includes(phrase)) {
      closingSignals.push(phrase);
    }
  }

  // Determine deal outcome
  let dealOutcome = 'in_negotiation';
  let closureProbability = 50;

  if (closingSignals.length > 0 || lower.includes('sold') || lower.includes('receipt') || lower.includes('payment successful') || lower.includes('ill take it')) {
    dealOutcome = 'won';
    closureProbability = 95;
  } else if (lower.includes('come back later') || lower.includes('just looking') || lower.includes('cannot afford') || lower.includes('walk away')) {
    dealOutcome = 'lost';
    closureProbability = 20;
  } else if (transcripts.length < 4) {
    dealOutcome = 'inquiry_only';
    closureProbability = 35;
  } else {
    dealOutcome = 'in_negotiation';
    closureProbability = 60;
  }

  // Sentiment analysis
  let customerSentiment = 'neutral';
  const posCount = (lower.match(/great|awesome|perfect|love|amazing|nice|good|deal|like|yes|sounds good/g) || []).length;
  const negCount = (lower.match(/bad|slow|expensive|hate|no|disappointed|issue|defect|broken|unhappy/g) || []).length;
  if (posCount > negCount + 1) customerSentiment = 'positive';
  else if (negCount > posCount + 1) customerSentiment = 'negative';

  // Primary customer intent
  let customerIntent = 'General iPhone exploration';
  if (devicesDiscussed.length > 0) {
    customerIntent = `Inquiry & purchase evaluation for ${devicesDiscussed[0]}`;
  } else if (lower.includes('repair') || lower.includes('screen') || lower.includes('battery')) {
    customerIntent = 'Service & repair inquiry';
  } else if (lower.includes('trade in') || lower.includes('upgrade')) {
    customerIntent = 'Trade-in upgrade evaluation';
  }

  // Missed opportunities
  const missedOpportunities = [];
  if (!lower.includes('applecare') && !lower.includes('warranty')) {
    missedOpportunities.push('Did not pitch AppleCare+ protection plan');
  }
  if (!lower.includes('case') && !lower.includes('screen protector')) {
    missedOpportunities.push('Did not offer protective bundle (MagSafe case + screen protector)');
  }
  if (!lower.includes('trade in') && !lower.includes('old phone')) {
    missedOpportunities.push('Did not ask if customer has an existing device for trade-in credit');
  }

  // Sales rep performance
  let repScore = 80;
  const strengths = [];
  const areasToImprove = [];

  if (dealOutcome === 'won') {
    repScore += 15;
    strengths.push('Successfully closed the transaction and handled client questions.');
  }
  if (objections.length > 0 && dealOutcome === 'won') {
    strengths.push('Effectively navigated customer hesitation/objections.');
  }
  if (customerSentiment === 'positive') {
    strengths.push('Maintained warm, hospitable and professional customer engagement.');
  }
  if (missedOpportunities.length > 0) {
    repScore -= (missedOpportunities.length * 5);
    areasToImprove.push(...missedOpportunities);
  }
  repScore = Math.max(50, Math.min(100, repScore));

  const summary = `Customer visited store with interest in ${devicesDiscussed.join(', ') || 'Apple products'}. ` +
    `Conversation lasted ${Math.round((metadata.durationSeconds || 60))}s. ` +
    (objections.length ? `Customer voiced concerns regarding ${objections.join(', ')}. ` : 'No major price or feature objections encountered. ') +
    `Final outcome concluded as "${dealOutcome.toUpperCase()}" with ${closureProbability}% estimated closure confidence.`;

  const coachingNotes = dealOutcome === 'won'
    ? 'Excellent close! Ensure the customer is onboarded to iCloud transfer and verify AppleCare registration before they leave.'
    : 'Follow up recommendation: Send digital quotation or trade-in estimate link via SMS/WhatsApp within 2 hours while purchase intent is warm.';

  // If GEMINI_API_KEY is present in process.env, we can enrich summary with Gemini Free Tier!
  if (process.env.GEMINI_API_KEY && transcripts.length > 3) {
    try {
      const model = 'gemini-flash-latest';
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are an expert Apple Retail sales intelligence AI. Analyze this conversation transcript:\n${fullText}\nProvide a concise 2-sentence summary and 1 key sales coaching advice.`
            }]
          }]
        })
      });
      const data = await response.json();
      if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        // Enriched AI summary
        const aiText = data.candidates[0].content.parts[0].text;
        return {
          dealOutcome,
          closureProbability,
          customerSentiment,
          customerIntent,
          devicesDiscussed,
          objections,
          closingSignals,
          summary: aiText,
          salesRepPerformance: {
            score: repScore,
            strengths,
            areasToImprove,
            coachingNotes
          },
          missedOpportunities
        };
      }
    } catch (err) {
      console.warn('Gemini enrichment skipped (fallback to local retail engine):', err.message);
    }
  }

  return {
    dealOutcome,
    closureProbability,
    customerSentiment,
    customerIntent,
    devicesDiscussed,
    objections,
    closingSignals,
    summary,
    salesRepPerformance: {
      score: repScore,
      strengths,
      areasToImprove,
      coachingNotes
    },
    missedOpportunities
  };
}

module.exports = {
  analyzeRealtimeChunk,
  generateFullAnalysis
};
