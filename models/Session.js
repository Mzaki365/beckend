const mongoose = require('mongoose');

const TranscriptItemSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now
  },
  speaker: {
    type: String,
    enum: ['customer', 'sales_rep', 'system'],
    default: 'customer'
  },
  text: {
    type: String,
    required: true
  },
  confidence: {
    type: Number,
    default: 0.95
  },
  signal: {
    type: String,
    default: null // e.g. "CLOSING_SIGNAL", "OBJECTION", "INQUIRY"
  }
}, { _id: false });

const SessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  storeCode: {
    type: String,
    required: true,
    index: true
  },
  storeName: {
    type: String,
    required: true
  },
  deviceId: {
    type: String,
    default: 'terminal-01'
  },
  salesRep: {
    type: String,
    default: 'Sales Specialist'
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'cancelled'],
    default: 'active',
    index: true
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  endedAt: {
    type: Date
  },
  durationSeconds: {
    type: Number,
    default: 0
  },
  audioUrl: {
    type: String,
    default: null
  },
  audioFileName: {
    type: String,
    default: null
  },
  transcripts: [TranscriptItemSchema],
  analytics: {
    dealOutcome: {
      type: String,
      enum: ['won', 'lost', 'in_negotiation', 'inquiry_only'],
      default: 'in_negotiation'
    },
    closureProbability: {
      type: Number,
      default: 50
    },
    customerSentiment: {
      type: String,
      enum: ['positive', 'neutral', 'negative'],
      default: 'neutral'
    },
    customerIntent: {
      type: String,
      default: 'Product exploration'
    },
    devicesDiscussed: [{
      type: String
    }],
    objections: [{
      type: String
    }],
    closingSignals: [{
      type: String
    }],
    summary: {
      type: String,
      default: ''
    },
    salesRepPerformance: {
      score: { type: Number, default: 85 },
      strengths: [{ type: String }],
      areasToImprove: [{ type: String }],
      coachingNotes: { type: String, default: '' }
    },
    missedOpportunities: [{
      type: String
    }]
  },
  dealAnalysis: {
    customerRequirements: {
      type: String,
      default: 'Not mentioned'
    },
    productsDiscussed: [{
      type: String
    }],
    budgetAndPrice: {
      type: String,
      default: 'Not mentioned'
    },
    customerQuestions: [{
      type: String
    }],
    customerObjections: [{
      type: String
    }],
    customerBuyingIntent: {
      type: String,
      enum: ['High', 'Medium', 'Low', 'Unclear'],
      default: 'Unclear'
    },
    salespersonResponse: {
      type: String,
      default: 'Not mentioned'
    },
    conversationOutcome: {
      type: String,
      enum: ['Sale Confirmed', 'Follow-up Required', 'Not Converted', 'Unclear'],
      default: 'Unclear'
    },
    nextRecommendedAction: {
      type: String,
      default: 'Not mentioned'
    },
    summary: {
      type: String,
      default: 'Not mentioned'
    },
    keyMoments: [{
      excerpt: { type: String, required: true },
      speaker: { type: String, default: 'Customer' },
      significance: { type: String, default: '' }
    }],
    analysisStatus: {
      type: String,
      enum: ['pending', 'analyzing', 'completed', 'failed', 'empty_skipped'],
      default: 'pending'
    },
    analysisError: {
      type: String,
      default: null
    },
    transcriptVersionHash: {
      type: String,
      default: null
    },
    lastAnalyzedAt: {
      type: Date,
      default: null
    },
    isOutdated: {
      type: Boolean,
      default: false
    }
  },
  // Module 7: Salesperson Performance & Quality Scorecard
  scorecard: {
    status: {
      type: String,
      enum: ['pending', 'evaluating', 'completed', 'failed', 'insufficient_evidence', 'empty_skipped'],
      default: 'pending'
    },
    overallScore: {
      type: Number,
      default: null
    },
    hasSufficientEvidence: {
      type: Boolean,
      default: false
    },
    evaluableDimensionsCount: {
      type: Number,
      default: 0
    },
    rubricVersion: {
      type: String,
      default: '1.0'
    },
    dimensions: {
      greeting: {
        score: { type: Number, default: null },
        sufficientEvidence: { type: Boolean, default: false },
        explanation: { type: String, default: 'Insufficient evidence' },
        evidenceExcerpt: { type: String, default: '' }
      },
      understandingRequirements: {
        score: { type: Number, default: null },
        sufficientEvidence: { type: Boolean, default: false },
        explanation: { type: String, default: 'Insufficient evidence' },
        evidenceExcerpt: { type: String, default: '' }
      },
      productKnowledge: {
        score: { type: Number, default: null },
        sufficientEvidence: { type: Boolean, default: false },
        explanation: { type: String, default: 'Insufficient evidence' },
        evidenceExcerpt: { type: String, default: '' }
      },
      responseToObjections: {
        score: { type: Number, default: null },
        sufficientEvidence: { type: Boolean, default: false },
        explanation: { type: String, default: 'Insufficient evidence' },
        evidenceExcerpt: { type: String, default: '' }
      },
      communicationClarity: {
        score: { type: Number, default: null },
        sufficientEvidence: { type: Boolean, default: false },
        explanation: { type: String, default: 'Insufficient evidence' },
        evidenceExcerpt: { type: String, default: '' }
      },
      handlingConcerns: {
        score: { type: Number, default: null },
        sufficientEvidence: { type: Boolean, default: false },
        explanation: { type: String, default: 'Insufficient evidence' },
        evidenceExcerpt: { type: String, default: '' }
      },
      closingAttempt: {
        score: { type: Number, default: null },
        sufficientEvidence: { type: Boolean, default: false },
        explanation: { type: String, default: 'Insufficient evidence' },
        evidenceExcerpt: { type: String, default: '' }
      },
      followUpCommitment: {
        score: { type: Number, default: null },
        sufficientEvidence: { type: Boolean, default: false },
        explanation: { type: String, default: 'Insufficient evidence' },
        evidenceExcerpt: { type: String, default: '' }
      }
    },
    coachingFeedback: {
      handledWell: [{ type: String }],
      areasToImprove: [{ type: String }],
      suggestedAlternative: { type: String, default: '' },
      missedOpportunity: { type: String, default: '' },
      evidenceQuote: { type: String, default: '' }
    },
    transcriptVersionHash: {
      type: String,
      default: null
    },
    lastEvaluatedAt: {
      type: Date,
      default: null
    },
    isOutdated: {
      type: Boolean,
      default: false
    },
    evaluationNotes: {
      type: String,
      default: ''
    }
  }
}, {
  timestamps: true
});

// Module 9: Compound indexes for high-performance customer & sales intelligence analytics
SessionSchema.index({ status: 1, startedAt: -1, storeCode: 1 });
SessionSchema.index({ 'dealAnalysis.conversationOutcome': 1, startedAt: -1 });
SessionSchema.index({ 'dealAnalysis.productsDiscussed': 1, startedAt: -1 });

module.exports = mongoose.model('Session', SessionSchema);
