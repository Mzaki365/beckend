const mongoose = require('mongoose');

const StoreSchema = new mongoose.Schema({
  storeCode: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  location: {
    type: String,
    default: 'Store Branch'
  },
  manager: {
    type: String,
    default: 'Store Manager'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Store', StoreSchema);
