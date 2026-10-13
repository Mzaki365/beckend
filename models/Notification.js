/**
 * Storelistener — Notification Model (Module 8)
 * File: models/Notification.js
 */

const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  type: {
    type: String,
    enum: [
      'store_offline',
      'store_online',
      'conversation_started',
      'conversation_completed',
      'sale_confirmed',
      'follow_up_required',
      'high_intent_unclear_outcome',
      'analysis_failure',
      'store_inactivity',
    ],
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  severity: {
    type: String,
    enum: ['info', 'success', 'warning', 'error'],
    default: 'info',
  },
  storeId: {
    type: String,
    default: null,
  },
  storeCode: {
    type: String,
    default: null,
    index: true,
  },
  storeName: {
    type: String,
    default: null,
  },
  salesRep: {
    type: String,
    default: null,
  },
  sessionId: {
    type: String,
    default: null,
    index: true,
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true,
  },
  readAt: {
    type: Date,
    default: null,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  targetRoles: [{
    type: String,
    enum: ['store_admin', 'sales_manager'],
    default: ['store_admin', 'sales_manager'],
  }],
}, {
  timestamps: true,
});

module.exports = mongoose.model('Notification', NotificationSchema);
