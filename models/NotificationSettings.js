/**
 * Storelistener — Notification Settings Model (Module 8)
 * File: models/NotificationSettings.js
 */

const mongoose = require('mongoose');

const RuleConfigSchema = new mongoose.Schema({
  enabled: {
    type: Boolean,
    default: true,
  },
  severity: {
    type: String,
    enum: ['info', 'success', 'warning', 'error'],
    default: 'info',
  },
  thresholdMinutes: {
    type: Number,
    default: 60,
  },
}, { _id: false });

const NotificationSettingsSchema = new mongoose.Schema({
  userId: {
    type: String,
    default: 'global_owner',
    unique: true,
    index: true,
  },
  rules: {
    store_offline: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'error' }),
    },
    store_online: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'info' }),
    },
    conversation_started: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'info' }),
    },
    conversation_completed: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'info' }),
    },
    sale_confirmed: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'success' }),
    },
    follow_up_required: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'warning' }),
    },
    high_intent_unclear_outcome: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'warning' }),
    },
    analysis_failure: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'error' }),
    },
    store_inactivity: {
      type: RuleConfigSchema,
      default: () => ({ enabled: true, severity: 'warning', thresholdMinutes: 60 }),
    },
  },
  emailDelivery: {
    enabled: {
      type: Boolean,
      default: false,
    },
    recipientEmail: {
      type: String,
      default: '',
    },
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('NotificationSettings', NotificationSettingsSchema);
