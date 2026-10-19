// services/userStore.js - Resilient User Repository (MongoDB Atlas with Local Persistence Fallback)
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Local storage helper
function loadLocalUsers() {
  if (!fs.existsSync(DATA_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Error reading local users file:', err.message);
    return [];
  }
}

function saveLocalUsers(users) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing local users file:', err.message);
  }
}

// Seed default users if empty (1 Store Admin, 1 Approved Sales Manager, 1 Pending Sales Manager)
async function seedDefaultUsers() {
  const isMongoReady = mongoose.connection.readyState === 1;

  if (isMongoReady) {
    try {
      const adminCount = await User.countDocuments({ role: 'store_admin' });
      if (adminCount === 0) {
        const defaultAdmin = new User({
          name: 'Store Admin',
          email: 'admin@store.com',
          password: 'admin123',
          role: 'store_admin',
          storeCode: 'STORE-NYC-01',
          storeName: 'Apple Authorized - 5th Ave',
          status: 'approved',
          approvedAt: new Date(),
          approvedBy: 'System Auto-Seed'
        });
        await defaultAdmin.save();
        console.log('👑 Seeded default Store Admin in MongoDB: admin@store.com / admin123');

        // Also seed an approved sales manager
        const managerCount = await User.countDocuments({ email: 'manager@store.com' });
        if (managerCount === 0) {
          const defaultManager = new User({
            name: 'Sarah Connor',
            email: 'manager@store.com',
            password: 'manager123',
            role: 'sales_manager',
            storeCode: 'STORE-NYC-01',
            storeName: 'Apple Authorized - 5th Ave',
            status: 'approved',
            approvedAt: new Date(),
            approvedBy: 'Store Admin'
          });
          await defaultManager.save();
          console.log('💼 Seeded approved Sales Manager in MongoDB: manager@store.com / manager123');
        }

        // Seed a pending sales manager for testing verification
        const pendingCount = await User.countDocuments({ email: 'pending.sales@store.com' });
        if (pendingCount === 0) {
          const pendingManager = new User({
            name: 'Michael Scott',
            email: 'pending.sales@store.com',
            password: 'sales123',
            role: 'sales_manager',
            storeCode: 'STORE-NYC-01',
            storeName: 'Apple Authorized - 5th Ave',
            status: 'pending'
          });
          await pendingManager.save();
          console.log('⏳ Seeded pending Sales Manager in MongoDB: pending.sales@store.com / sales123');
        }
      }
      return;
    } catch (err) {
      console.warn('MongoDB seed warning:', err.message);
    }
  }

  // Local fallback seed
  let localUsers = loadLocalUsers();
  if (localUsers.length === 0) {
    const adminSalt = await bcrypt.genSalt(10);
    const adminHash = await bcrypt.hash('admin123', adminSalt);

    const managerSalt = await bcrypt.genSalt(10);
    const managerHash = await bcrypt.hash('manager123', managerSalt);

    const pendingSalt = await bcrypt.genSalt(10);
    const pendingHash = await bcrypt.hash('sales123', pendingSalt);

    localUsers = [
      {
        id: 'admin-001',
        _id: 'admin-001',
        name: 'Store Admin',
        email: 'admin@store.com',
        password: adminHash,
        role: 'store_admin',
        storeCode: 'STORE-NYC-01',
        storeName: 'Apple Authorized - 5th Ave',
        status: 'approved',
        approvedAt: new Date().toISOString(),
        approvedBy: 'System Auto-Seed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'manager-001',
        _id: 'manager-001',
        name: 'Sarah Connor',
        email: 'manager@store.com',
        password: managerHash,
        role: 'sales_manager',
        storeCode: 'STORE-NYC-01',
        storeName: 'Apple Authorized - 5th Ave',
        status: 'approved',
        approvedAt: new Date().toISOString(),
        approvedBy: 'Store Admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'pending-001',
        _id: 'pending-001',
        name: 'Michael Scott',
        email: 'pending.sales@store.com',
        password: pendingHash,
        role: 'sales_manager',
        storeCode: 'STORE-NYC-01',
        storeName: 'Apple Authorized - 5th Ave',
        status: 'pending',
        approvedAt: null,
        approvedBy: null,
        rejectionReason: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
    saveLocalUsers(localUsers);
    console.log('👑 Local fallback users initialized (admin@store.com, manager@store.com, pending.sales@store.com)');
  }
}

// Find user by email
async function findUserByEmail(email) {
  const normEmail = (email || '').toLowerCase().trim();
  if (mongoose.connection.readyState === 1) {
    try {
      const u = await User.findOne({ email: normEmail });
      if (u) return u;
    } catch (err) {
      console.warn('Mongo findUserByEmail fallback:', err.message);
    }
  }

  const locals = loadLocalUsers();
  return locals.find(u => u.email.toLowerCase().trim() === normEmail) || null;
}

// Find user by ID
async function findUserById(id) {
  if (mongoose.connection.readyState === 1) {
    try {
      if (mongoose.isValidObjectId(id)) {
        const u = await User.findById(id);
        if (u) return u;
      }
    } catch (err) {
      console.warn('Mongo findUserById fallback:', err.message);
    }
  }

  const locals = loadLocalUsers();
  return locals.find(u => (u.id === id || u._id === id || String(u._id) === String(id))) || null;
}

// Create new user (Sales Manager only via public signup)
async function createUser({ name, email, password, role, storeCode = 'STORE-01', storeName }) {
  const normEmail = (email || '').toLowerCase().trim();
  
  if (role === 'store_admin') {
    throw new Error('Public registration of Store Admin / Owner accounts is strictly disabled.');
  }

  // Canonicalize store code and name to the 3 configured retail stores
  let canonicalCode = 'STORE-01';
  let canonicalName = 'Star Store 01';

  const cleanStore = (storeCode || '').toUpperCase().trim();
  if (cleanStore.includes('02') || cleanStore.includes('LA')) {
    canonicalCode = 'STORE-02';
    canonicalName = 'Star Store 02';
  } else if (cleanStore.includes('03') || cleanStore.includes('MIA')) {
    canonicalCode = 'STORE-03';
    canonicalName = 'Star Store 03';
  } else {
    canonicalCode = 'STORE-01';
    canonicalName = 'Star Store 01';
  }

  const assignedRole = 'sales_manager';
  const status = 'pending';

  if (mongoose.connection.readyState === 1) {
    try {
      const newUser = new User({
        name: name.trim(),
        email: normEmail,
        password,
        role: assignedRole,
        storeCode: canonicalCode,
        storeName: storeName || canonicalName,
        status,
        approvedAt: null,
        approvedBy: null
      });
      await newUser.save();
      return newUser;
    } catch (err) {
      console.warn('Mongo createUser fallback to local:', err.message);
    }
  }

  // Local fallback creation
  const locals = loadLocalUsers();
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);
  const newLocalUser = {
    id: 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    _id: 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    name: name.trim(),
    email: normEmail,
    password: hashedPassword,
    role: assignedRole,
    storeCode: canonicalCode,
    storeName: storeName || canonicalName,
    status,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  locals.push(newLocalUser);
  saveLocalUsers(locals);
  return newLocalUser;
}

// Compare password helper for either Mongoose document or plain object
async function verifyPassword(user, candidatePassword) {
  if (typeof user.comparePassword === 'function') {
    return user.comparePassword(candidatePassword);
  }
  return bcrypt.compare(candidatePassword, user.password);
}

// Get all users
async function getAllUsers() {
  if (mongoose.connection.readyState === 1) {
    try {
      return await User.find().sort({ createdAt: -1 });
    } catch (err) {
      console.warn('Mongo getAllUsers fallback:', err.message);
    }
  }
  return loadLocalUsers();
}

// Get pending sales managers
async function getPendingSalesManagers() {
  if (mongoose.connection.readyState === 1) {
    try {
      return await User.find({ role: 'sales_manager', status: 'pending' }).sort({ createdAt: -1 });
    } catch (err) {
      console.warn('Mongo getPendingSalesManagers fallback:', err.message);
    }
  }
  const locals = loadLocalUsers();
  return locals.filter(u => u.role === 'sales_manager' && u.status === 'pending');
}

// Approve sales manager
async function approveSalesManager(id, approvedByName = 'Store Admin') {
  if (mongoose.connection.readyState === 1) {
    try {
      if (mongoose.isValidObjectId(id)) {
        const u = await User.findById(id);
        if (u) {
          u.status = 'approved';
          u.approvedAt = new Date();
          u.approvedBy = approvedByName;
          u.rejectionReason = '';
          await u.save();
          return u;
        }
      }
    } catch (err) {
      console.warn('Mongo approveSalesManager fallback:', err.message);
    }
  }

  const locals = loadLocalUsers();
  const idx = locals.findIndex(u => (u.id === id || u._id === id || String(u._id) === String(id)));
  if (idx !== -1) {
    locals[idx].status = 'approved';
    locals[idx].approvedAt = new Date().toISOString();
    locals[idx].approvedBy = approvedByName;
    locals[idx].rejectionReason = '';
    locals[idx].updatedAt = new Date().toISOString();
    saveLocalUsers(locals);
    return locals[idx];
  }
  return null;
}

// Reject sales manager
async function rejectSalesManager(id, reason = 'Verification declined by Store Admin', rejectedByName = 'Store Admin') {
  if (mongoose.connection.readyState === 1) {
    try {
      if (mongoose.isValidObjectId(id)) {
        const u = await User.findById(id);
        if (u) {
          u.status = 'rejected';
          u.rejectedAt = new Date();
          u.rejectedBy = rejectedByName;
          u.rejectionReason = reason;
          await u.save();
          return u;
        }
      }
    } catch (err) {
      console.warn('Mongo rejectSalesManager fallback:', err.message);
    }
  }

  const locals = loadLocalUsers();
  const idx = locals.findIndex(u => (u.id === id || u._id === id || String(u._id) === String(id)));
  if (idx !== -1) {
    locals[idx].status = 'rejected';
    locals[idx].rejectedAt = new Date().toISOString();
    locals[idx].rejectedBy = rejectedByName;
    locals[idx].rejectionReason = reason;
    locals[idx].updatedAt = new Date().toISOString();
    saveLocalUsers(locals);
    return locals[idx];
  }
  return null;
}

// Disable a previously approved sales manager
async function disableSalesManager(id, disabledByName = 'Store Admin') {
  if (mongoose.connection.readyState === 1) {
    try {
      if (mongoose.isValidObjectId(id)) {
        const u = await User.findById(id);
        if (u) {
          u.status = 'disabled';
          u.disabledAt = new Date();
          u.disabledBy = disabledByName;
          await u.save();
          return u;
        }
      }
    } catch (err) {
      console.warn('Mongo disableSalesManager fallback:', err.message);
    }
  }

  const locals = loadLocalUsers();
  const idx = locals.findIndex(u => (u.id === id || u._id === id || String(u._id) === String(id)));
  if (idx !== -1) {
    locals[idx].status = 'disabled';
    locals[idx].disabledAt = new Date().toISOString();
    locals[idx].disabledBy = disabledByName;
    locals[idx].updatedAt = new Date().toISOString();
    saveLocalUsers(locals);
    return locals[idx];
  }
  return null;
}

module.exports = {
  seedDefaultUsers,
  findUserByEmail,
  findUserById,
  createUser,
  verifyPassword,
  getAllUsers,
  getPendingSalesManagers,
  approveSalesManager,
  rejectSalesManager,
  disableSalesManager
};
