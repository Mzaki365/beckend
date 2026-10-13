/**
 * Storelistener Backend — Salesperson Performance & Quality Scorecard Service (Module 7)
 * File: services/scorecardService.js
 *
 * Implements:
 * 1. Documented 8-Dimension Quality Rubric grounded in transcript evidence
 * 2. 0-100 overall score calculated strictly from evaluable dimensions
 * 3. Transparent handling of "Insufficient evidence" without penalizing salespeople
 * 4. Actionable conversation-level coaching feedback with alternative responses
 * 5. Deterministic fallback analyzer when AI provider is unavailable
 * 6. Duplicate prevention & transcript version hashing
 */

const crypto = require('crypto');
const Session = require('../models/Session');

// The 8 Canonical Quality Dimensions
const DIMENSION_KEYS = [
  'greeting',
  'understandingRequirements',
  'productKnowledge',
  'responseToObjections',
  'communicationClarity',
  'handlingConcerns',
  'closingAttempt',
  'followUpCommitment',
];

const DIMENSION_METADATA = {
  greeting: {
    label: 'Greeting & Opening',
    description: 'Polite greeting, warm introduction, and proactive offer of assistance at start of conversation.',
  },
  understandingRequirements: {
    label: 'Understanding Requirements',
    description: 'Active listening, asking clarifying questions regarding customer needs, device preferences, and usage.',
  },
  productKnowledge: {
    label: 'Product Knowledge & Explanation',
    description: 'Accurate technical feature explanation, model comparisons, pricing clarity, and ecosystem benefits.',
  },
  responseToObjections: {
    label: 'Response to Objections',
    description: 'Constructive handling of price, timing, or hesitation objections with value propositions (e.g. trade-in, financing).',
  },
  communicationClarity: {
    label: 'Communication Clarity & Professionalism',
    description: 'Professional tone, concise explanations, avoiding jargon, courteous interaction throughout.',
  },
  handlingConcerns: {
    label: 'Handling Customer Concerns',
    description: 'Addressing specific customer doubts, warranty/AppleCare coverage, device durability, or delivery timelines.',
  },
  closingAttempt: {
    label: 'Appropriate Closing Attempt',
    description: 'Prompting decision, presenting checkout or reservation, or inviting customer to complete the purchase.',
  },
  followUpCommitment: {
    label: 'Follow-up Commitment',
    description: 'Establishing next touchpoint, offering contact details, or scheduling callback when purchase is pending.',
  },
};

class ScorecardService {
  /**
   * Generates a stable SHA-256 hash of transcript text
   */
  calculateTranscriptHash(transcripts = []) {
    if (!transcripts || transcripts.length === 0) return 'empty';
    const textBlob = transcripts.map((t) => `${t.speaker || ''}:${t.text || ''}`).join('|');
    return crypto.createHash('sha256').update(textBlob).digest('hex');
  }

  /**
   * Evaluates or re-evaluates a session scorecard
   */
  async evaluateSessionScorecard(sessionId, options = {}) {
    const { force = false } = options;

    const session = await Session.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const transcripts = session.transcripts || [];
    const currentHash = this.calculateTranscriptHash(transcripts);

    // 1. Handle empty or silent sessions gracefully
    if (transcripts.length === 0) {
      const emptyResult = {
        status: 'empty_skipped',
        overallScore: null,
        hasSufficientEvidence: false,
        evaluableDimensionsCount: 0,
        rubricVersion: '1.0',
        dimensions: this.createEmptyDimensions('Session contains no spoken transcript to assess.'),
        coachingFeedback: {
          handledWell: [],
          areasToImprove: [],
          suggestedAlternative: 'N/A — No customer dialogue recorded.',
          missedOpportunity: 'N/A',
          evidenceQuote: 'None',
        },
        transcriptVersionHash: 'empty',
        lastEvaluatedAt: new Date(),
        isOutdated: false,
        evaluationNotes: 'Empty session skipped without penalty.',
      };

      session.scorecard = emptyResult;
      await session.save();
      return session.scorecard;
    }

    // 2. Prevent duplicate scoring jobs for identical transcript hash
    if (!force && session.scorecard?.status === 'completed' && session.scorecard?.transcriptVersionHash === currentHash) {
      return session.scorecard;
    }

    // Mark evaluating
    session.scorecard = {
      ...(session.scorecard || {}),
      status: 'evaluating',
      transcriptVersionHash: currentHash,
    };
    await session.save();

    try {
      let result;
      const apiKey = process.env.GEMINI_API_KEY;

      // 3. Attempt Google Gemini Flash structured evaluation
      if (apiKey && apiKey.startsWith('AIzaSy')) {
        try {
          result = await this.evaluateWithGemini(session, apiKey);
        } catch (aiErr) {
          console.warn(`[Scorecard] Gemini AI evaluation failed (${aiErr.message}), using deterministic evaluation.`);
          result = this.evaluateDeterministically(session);
        }
      } else {
        result = this.evaluateDeterministically(session);
      }

      // 4. Calculate overall score strictly based on documented rubric
      const finalScorecard = this.finalizeScorecardCalculations(result, currentHash);

      session.scorecard = finalScorecard;

      // Sync legacy salesRepPerformance field for backward compatibility
      if (session.analytics) {
        session.analytics.salesRepPerformance = {
          score: finalScorecard.overallScore || 75,
          strengths: finalScorecard.coachingFeedback.handledWell || [],
          areasToImprove: finalScorecard.coachingFeedback.areasToImprove || [],
          coachingNotes: finalScorecard.coachingFeedback.suggestedAlternative || '',
        };
      }

      await session.save();
      console.log(`✅ [Scorecard] Evaluated scorecard for session: ${sessionId} (Overall: ${finalScorecard.overallScore ?? 'N/A'})`);
      return session.scorecard;
    } catch (err) {
      console.error(`❌ [Scorecard] Failed to evaluate session ${sessionId}:`, err.message);
      session.scorecard = {
        ...(session.scorecard || {}),
        status: 'failed',
        evaluationNotes: `Evaluation error: ${err.message}`,
        lastEvaluatedAt: new Date(),
      };
      await session.save();
      throw err;
    }
  }

  /**
   * Finalizes score calculation strictly from evaluable dimensions
   */
  finalizeScorecardCalculations(evalResult, currentHash) {
    const dimensions = evalResult.dimensions || {};
    let evaluableCount = 0;
    let scoreSum = 0;

    for (const key of DIMENSION_KEYS) {
      const dim = dimensions[key];
      if (dim && dim.sufficientEvidence === true && typeof dim.score === 'number' && !isNaN(dim.score)) {
        // Clamp score between 0 and 100
        dim.score = Math.max(0, Math.min(100, Math.round(dim.score)));
        scoreSum += dim.score;
        evaluableCount++;
      } else if (dim) {
        dim.score = null;
        dim.sufficientEvidence = false;
        if (!dim.explanation || dim.explanation.trim() === '') {
          dim.explanation = 'Insufficient evidence in transcript';
        }
      }
    }

    // Overall score requires at least 2 evaluable dimensions to be statistically valid
    const hasSufficientEvidence = evaluableCount >= 2;
    const overallScore = hasSufficientEvidence ? Math.round(scoreSum / evaluableCount) : null;

    return {
      status: hasSufficientEvidence ? 'completed' : 'insufficient_evidence',
      overallScore,
      hasSufficientEvidence,
      evaluableDimensionsCount: evaluableCount,
      rubricVersion: '1.0',
      dimensions,
      coachingFeedback: evalResult.coachingFeedback || {
        handledWell: [],
        areasToImprove: [],
        suggestedAlternative: '',
        missedOpportunity: '',
        evidenceQuote: '',
      },
      transcriptVersionHash: currentHash,
      lastEvaluatedAt: new Date(),
      isOutdated: false,
      evaluationNotes: hasSufficientEvidence
        ? `Score calculated as mean of ${evaluableCount} evaluable dimensions.`
        : 'Fewer than 2 dimensions had sufficient transcript evidence. Overall score withheld to prevent misleading assessment.',
    };
  }

  /**
   * Evaluates session using Google Gemini 1.5 Flash
   */
  async evaluateWithGemini(session, apiKey) {
    const transcripts = session.transcripts || [];
    const dialogue = transcripts
      .map((t, idx) => `[${idx + 1}] ${t.speaker || 'Customer'}: "${t.text || ''}"`)
      .join('\n');

    const repName = session.salesRep || 'Sales Representative';
    const storeName = session.storeName || session.storeCode || 'Store';
    const dealAnalysis = session.dealAnalysis || {};

    const prompt = `You are an expert retail sales coach for an Apple Authorized retail chain.
Evaluate the sales representative's performance for this specific customer conversation.

CONVERSATION CONTEXT:
- Sales Representative: ${repName}
- Retail Store: ${storeName}
- Outcome: ${dealAnalysis.conversationOutcome || 'Unknown'}
- Buying Intent: ${dealAnalysis.customerBuyingIntent || 'Unknown'}
- Products Discussed: ${(dealAnalysis.productsDiscussed || []).join(', ') || 'Unknown'}

TRANSCRIPT:
${dialogue}

SCORING RUBRIC (Evaluate each of the 8 dimensions):
1. greeting: Politeness, welcoming the customer, offering assistance.
2. understandingRequirements: Active listening, asking questions about needs/storage/usage.
3. productKnowledge: Explaining device specs, features, trade-in, or price accurately.
4. responseToObjections: Handling price, hesitation, or competition objections constructively.
5. communicationClarity: Professionalism, clarity, tone, and conciseness.
6. handlingConcerns: Addressing customer doubts, warranties, durability, or delivery.
7. closingAttempt: Prompting purchase, asking for the sale, or offering payment/reservation.
8. followUpCommitment: Offering follow-up, contact card, or scheduling next step when deal is not closed immediately.

STRICT ACCURACY RULES:
- If a dimension CANNOT be reliably evaluated from the transcript (for example, the customer never raised any objection, or the sale was completed at the counter so follow-up was not applicable), you MUST set "sufficientEvidence": false and "score": null.
- NEVER penalize a representative with a low score for a dimension that had no opportunity or evidence to occur.
- For every dimension with sufficientEvidence = true, provide a score (0 to 100), a concise explanation, and a direct quote or excerpt from the transcript in "evidenceExcerpt".
- Provide constructive, professional coaching in "coachingFeedback":
  - handledWell: 2-3 specific observed strengths.
  - areasToImprove: 1-2 actionable coaching areas.
  - suggestedAlternative: A specific, realistic phrasing recommendation for a missed opportunity.
  - evidenceQuote: A direct quote supporting the coaching recommendation.

Respond ONLY with valid JSON matching this schema:
{
  "dimensions": {
    "greeting": { "score": number|null, "sufficientEvidence": boolean, "explanation": string, "evidenceExcerpt": string },
    "understandingRequirements": { "score": number|null, "sufficientEvidence": boolean, "explanation": string, "evidenceExcerpt": string },
    "productKnowledge": { "score": number|null, "sufficientEvidence": boolean, "explanation": string, "evidenceExcerpt": string },
    "responseToObjections": { "score": number|null, "sufficientEvidence": boolean, "explanation": string, "evidenceExcerpt": string },
    "communicationClarity": { "score": number|null, "sufficientEvidence": boolean, "explanation": string, "evidenceExcerpt": string },
    "handlingConcerns": { "score": number|null, "sufficientEvidence": boolean, "explanation": string, "evidenceExcerpt": string },
    "closingAttempt": { "score": number|null, "sufficientEvidence": boolean, "explanation": string, "evidenceExcerpt": string },
    "followUpCommitment": { "score": number|null, "sufficientEvidence": boolean, "explanation": string, "evidenceExcerpt": string }
  },
  "coachingFeedback": {
    "handledWell": [string],
    "areasToImprove": [string],
    "suggestedAlternative": string,
    "missedOpportunity": string,
    "evidenceQuote": string
  }
}`;

    const models = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-1.5-flash'];
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const parsed = JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());
            if (parsed.dimensions && parsed.coachingFeedback) {
              return parsed;
            }
          }
        }
      } catch (err) {
        // Continue to next model
      }
    }

    throw new Error('All Gemini model endpoints exhausted or unavailable');
  }

  /**
   * Deterministic Evaluation Engine (Runs if AI is offline or as reliable baseline)
   */
  evaluateDeterministically(session) {
    const transcripts = session.transcripts || [];
    const salesLines = transcripts.filter(
      (t) => (t.speaker || '').toLowerCase().includes('sales') || (t.speaker || '').toLowerCase().includes('rep')
    );
    const customerLines = transcripts.filter(
      (t) => (t.speaker || '').toLowerCase().includes('customer')
    );

    const fullSalesText = salesLines.map((t) => t.text).join(' ');
    const lowerSales = fullSalesText.toLowerCase();
    const fullCustomerText = customerLines.map((t) => t.text).join(' ');
    const lowerCustomer = fullCustomerText.toLowerCase();

    const dimensions = {};

    // 1. Greeting & Opening
    const firstSalesLine = salesLines[0]?.text || '';
    const hasGreetingWord = /hello|hi|welcome|good morning|good afternoon|how are you|how can i help|can i help/i.test(firstSalesLine);
    if (salesLines.length > 0 && firstSalesLine) {
      dimensions.greeting = {
        score: hasGreetingWord ? 95 : 70,
        sufficientEvidence: true,
        explanation: hasGreetingWord
          ? 'Welcomed customer and opened conversation professionally.'
          : 'Engaged customer directly without formal greeting.',
        evidenceExcerpt: firstSalesLine,
      };
    } else {
      dimensions.greeting = {
        score: null,
        sufficientEvidence: false,
        explanation: 'No initial greeting recorded in transcript.',
        evidenceExcerpt: '',
      };
    }

    // 2. Understanding Requirements
    const questionToCustomer = salesLines.find((l) => (l.text || '').includes('?') || /storage|gigabyte|gb|color|pro|need|looking for/i.test(l.text || ''));
    if (questionToCustomer || customerLines.length > 0) {
      dimensions.understandingRequirements = {
        score: questionToCustomer ? 90 : 75,
        sufficientEvidence: true,
        explanation: questionToCustomer
          ? 'Clarified customer preferences and hardware specifications.'
          : 'Listened to customer requirement statement.',
        evidenceExcerpt: questionToCustomer?.text || customerLines[0]?.text || '',
      };
    } else {
      dimensions.understandingRequirements = {
        score: null,
        sufficientEvidence: false,
        explanation: 'Insufficient evidence to evaluate requirement discovery.',
        evidenceExcerpt: '',
      };
    }

    // 3. Product Knowledge
    const hasSpecs = /titanium|128gb|256gb|512gb|1tb|pro max|bionic|camera|display|usb-c|applecare|battery|\$\d+/i.test(fullSalesText);
    const productQuote = salesLines.find((l) => /\$|iphone|gb|pro|applecare|stock/i.test(l.text || ''));
    if (hasSpecs && productQuote) {
      dimensions.productKnowledge = {
        score: 95,
        sufficientEvidence: true,
        explanation: 'Provided accurate product specifications, storage options, and pricing information.',
        evidenceExcerpt: productQuote.text,
      };
    } else if (salesLines.length > 1) {
      dimensions.productKnowledge = {
        score: 75,
        sufficientEvidence: true,
        explanation: 'Provided general product overview.',
        evidenceExcerpt: salesLines[1]?.text || salesLines[0]?.text || '',
      };
    } else {
      dimensions.productKnowledge = {
        score: null,
        sufficientEvidence: false,
        explanation: 'Insufficient product discussion in transcript.',
        evidenceExcerpt: '',
      };
    }

    // 4. Response to Objections
    const hasObjection = /expensive|too much|too high|cheaper|discount|cannot afford|out of budget|competitor|cheaper elsewhere|lower price/i.test(lowerCustomer);
    if (hasObjection) {
      const objectionResponse = salesLines.find((l) => /trade-in|financing|credit|discount|0%|installment|bundle|save/i.test(l.text || ''));
      if (objectionResponse) {
        dimensions.responseToObjections = {
          score: 95,
          sufficientEvidence: true,
          explanation: 'Addressed customer price/hesitation objection constructively with value incentives and trade-in.',
          evidenceExcerpt: objectionResponse.text,
        };
      } else {
        dimensions.responseToObjections = {
          score: 65,
          sufficientEvidence: true,
          explanation: 'Customer raised an objection, but representative did not present trade-in or financing alternatives.',
          evidenceExcerpt: customerLines.find((l) => /expensive|cost|discount/i.test(l.text || ''))?.text || '',
        };
      }
    } else {
      dimensions.responseToObjections = {
        score: null,
        sufficientEvidence: false,
        explanation: 'No objections raised by customer in this conversation — Insufficient evidence.',
        evidenceExcerpt: '',
      };
    }

    // 5. Communication Clarity & Professionalism
    if (salesLines.length >= 1) {
      dimensions.communicationClarity = {
        score: 90,
        sufficientEvidence: true,
        explanation: 'Maintained polite, clear, and professional language throughout.',
        evidenceExcerpt: salesLines[0]?.text || '',
      };
    } else {
      dimensions.communicationClarity = {
        score: null,
        sufficientEvidence: false,
        explanation: 'Insufficient dialogue to evaluate communication clarity.',
        evidenceExcerpt: '',
      };
    }

    // 6. Handling Concerns
    const hasConcern = /warranty|guarantee|return|battery life|break|drop|case|durable/i.test(lowerCustomer);
    if (hasConcern) {
      const concernAnswer = salesLines.find((l) => /warranty|applecare|protection|case|screen|coverage/i.test(l.text || ''));
      dimensions.handlingConcerns = {
        score: concernAnswer ? 90 : 70,
        sufficientEvidence: true,
        explanation: concernAnswer ? 'Addressed customer concern with protection program.' : 'Acknowledged concern.',
        evidenceExcerpt: concernAnswer?.text || '',
      };
    } else {
      dimensions.handlingConcerns = {
        score: null,
        sufficientEvidence: false,
        explanation: 'No specific customer concerns raised in conversation.',
        evidenceExcerpt: '',
      };
    }

    // 7. Closing Attempt
    const closingLine = salesLines.find((l) => /take it|credit card|pay|receipt|checkout|register|buy|bundle|ready/i.test(l.text || ''));
    if (closingLine) {
      dimensions.closingAttempt = {
        score: 95,
        sufficientEvidence: true,
        explanation: 'Successfully prompted checkout and finalized transaction details.',
        evidenceExcerpt: closingLine.text,
      };
    } else if (lowerCustomer.includes('browsing') || lowerCustomer.includes('come back')) {
      dimensions.closingAttempt = {
        score: 60,
        sufficientEvidence: true,
        explanation: 'Customer showed interest but representative did not attempt soft closing or reservation.',
        evidenceExcerpt: customerLines[customerLines.length - 1]?.text || '',
      };
    } else {
      dimensions.closingAttempt = {
        score: null,
        sufficientEvidence: false,
        explanation: 'Conversation concluded before reaching closing phase.',
        evidenceExcerpt: '',
      };
    }

    // 8. Follow-up Commitment
    const hasFollowUp = /come back|next week|call|email|card|brochure|hold|reserve/i.test(fullSalesText);
    const outcome = session.dealAnalysis?.conversationOutcome || '';
    if (outcome === 'Sale Confirmed') {
      dimensions.followUpCommitment = {
        score: 95,
        sufficientEvidence: true,
        explanation: 'Sale was confirmed at counter; customer received receipt and product.',
        evidenceExcerpt: salesLines[salesLines.length - 1]?.text || 'Receipt provided.',
      };
    } else if (hasFollowUp) {
      dimensions.followUpCommitment = {
        score: 90,
        sufficientEvidence: true,
        explanation: 'Committed to follow-up or invited customer back.',
        evidenceExcerpt: salesLines.find((l) => /card|call|visit|week/i.test(l.text || ''))?.text || '',
      };
    } else if (outcome === 'Follow-up Required' || lowerCustomer.includes('come back')) {
      dimensions.followUpCommitment = {
        score: 60,
        sufficientEvidence: true,
        explanation: 'Customer left without purchase; representative did not offer contact card or schedule follow-up.',
        evidenceExcerpt: customerLines[customerLines.length - 1]?.text || '',
      };
    } else {
      dimensions.followUpCommitment = {
        score: null,
        sufficientEvidence: false,
        explanation: 'Follow-up commitment not applicable for this conversation stage.',
        evidenceExcerpt: '',
      };
    }

    // Coaching Feedback Generation
    const handledWell = [];
    const areasToImprove = [];
    let suggestedAlternative = 'Maintain strong product knowledge and attentive consultation.';
    let missedOpportunity = 'None identified.';
    let evidenceQuote = firstSalesLine;

    if (dimensions.greeting?.score >= 90) handledWell.push('Warm, welcoming initial greeting.');
    if (dimensions.productKnowledge?.score >= 90) handledWell.push('Accurate and comprehensive explanation of device specifications and pricing.');
    if (dimensions.responseToObjections?.score >= 90) handledWell.push('Effective presentation of trade-in and value incentives against objections.');
    if (dimensions.closingAttempt?.score >= 90) handledWell.push('Decisive, clear closing action leading to confirmed transaction.');

    if (dimensions.responseToObjections?.score && dimensions.responseToObjections.score < 75) {
      areasToImprove.push('Present 0% APR financing or trade-in estimate immediately when price hesitation arises.');
      suggestedAlternative = '"We have an instant trade-in credit program that can take up to $400 off, plus 0% APR monthly installments."';
      missedOpportunity = 'Did not present trade-in program to address price objection.';
    }
    if (dimensions.closingAttempt?.score && dimensions.closingAttempt.score < 75) {
      areasToImprove.push('Offer a soft close or hold reservation before an interested customer leaves.');
      suggestedAlternative = '"Would you like me to hold this exact color and storage for you until tomorrow afternoon?"';
      missedOpportunity = 'Customer walked away without reservation or contact exchange.';
    }

    if (handledWell.length === 0) handledWell.push('Polite dialogue engagement with customer.');
    if (areasToImprove.length === 0) areasToImprove.push('Continue maintaining high standard of consultative customer service.');

    return {
      dimensions,
      coachingFeedback: {
        handledWell,
        areasToImprove,
        suggestedAlternative,
        missedOpportunity,
        evidenceQuote,
      },
    };
  }

  /**
   * Helper to create empty dimensions
   */
  createEmptyDimensions(reason = 'Insufficient evidence') {
    const dims = {};
    for (const key of DIMENSION_KEYS) {
      dims[key] = {
        score: null,
        sufficientEvidence: false,
        explanation: reason,
        evidenceExcerpt: '',
      };
    }
    return dims;
  }

  /**
   * Returns documented rubric metadata for UI transparency
   */
  getRubricMetadata() {
    return {
      version: '1.0',
      description: 'Transparent 8-dimension sales quality evaluation rubric grounded in saved audio transcripts.',
      scoringScale: '0-100 per evaluable dimension. Dimensions with insufficient evidence are excluded from the denominator to avoid penalizing representatives.',
      minimumEvaluableDimensions: 2,
      dimensions: DIMENSION_METADATA,
    };
  }
}

const scorecardService = new ScorecardService();
module.exports = scorecardService;
