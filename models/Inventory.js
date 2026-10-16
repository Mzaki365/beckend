/**
 * Storelistener — Retail Inventory Model
 * File: models/Inventory.js
 *
 * Tracks authoritative product stock levels and low-stock alert thresholds by store.
 */

const mongoose = require('mongoose');

const InventorySchema = new mongoose.Schema({
  productName: {
    type: String,
    required: true,
    trim: true,
  },
  sku: {
    type: String,
    required: true,
    trim: true,
  },
  category: {
    type: String,
    default: 'iPhone Hardware',
  },
  storeCode: {
    type: String,
    required: true,
    index: true,
  },
  currentStock: {
    type: Number,
    required: true,
    default: 0,
  },
  lowStockThreshold: {
    type: Number,
    required: true,
    default: 5,
  },
  unitPrice: {
    type: Number,
    default: 0,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

InventorySchema.index({ storeCode: 1, sku: 1 }, { unique: true });

module.exports = mongoose.model('Inventory', InventorySchema);
