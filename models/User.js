// models/User.js - Storelistener User Schema
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['store_admin', 'sales_manager'],
    required: true,
    default: 'sales_manager'
  },
  storeCode: {
    type: String,
    default: 'STORE-NYC-01',
    trim: true
  },
  storeName: {
    type: String,
    default: 'Apple Authorized Store',
    trim: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'disabled'],
    default: function() {
      return this.role === 'store_admin' ? 'approved' : 'pending';
    }
  },
  approvedAt: {
    type: Date,
    default: null
  },
  approvedBy: {
    type: String,
    default: null
  },
  rejectedAt: {
    type: Date,
    default: null
  },
  rejectedBy: {
    type: String,
    default: null
  },
  rejectionReason: {
    type: String,
    default: ''
  },
  disabledAt: {
    type: Date,
    default: null
  },
  disabledBy: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Pre-save hook: Hash password and auto-approve Store Admin
UserSchema.pre('save', async function() {
  if (this.role === 'store_admin') {
    this.status = 'approved';
    if (!this.approvedAt) this.approvedAt = new Date();
    if (!this.approvedBy) this.approvedBy = 'Self (Store Admin - Auto Verified)';
  }
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
UserSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);
