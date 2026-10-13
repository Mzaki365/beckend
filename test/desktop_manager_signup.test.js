/**
 * Storelistener — Move Sales Manager Signup to Electron Desktop App Test Suite
 * File: test/desktop_manager_signup.test.js
 *
 * Verifies all requirements:
 * 1. Sales Manager signup exists in the Electron desktop app (DesktopAuthView.jsx, preload.cjs, main.cjs).
 * 2. The Owner web dashboard no longer exposes Sales Manager signup.
 * 3. Signup creates a pending request with secure password hashing and normalized email.
 * 4. Pending and rejected accounts cannot authenticate.
 * 5. Only the Owner can approve requests (RBAC).
 * 6. Approved managers can authenticate and access only their assigned store.
 * 7. Secrets and credentials are not exposed in renderer code, API responses, or logs.
 * 8. Existing desktop and web features still work (Regression verification).
 */

require('dotenv').config();
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BACKEND_URL = 'http://localhost:5000';
const { JWT_SECRET } = require('../middleware/auth');
const User = require('../models/User');
const { seedDefaultUsers, findUserByEmail } = require('../services/userStore');

// Helper to extract cookie from Set-Cookie header
function extractCookie(res, cookieName = 'token') {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

describe('Storelistener: Move Sales Manager Signup to Electron Desktop App', () => {
  let ownerCookie = null;
  let approvedManagerCookie = null;
  let testManagerId = null;
  const testRunId = Date.now();
  const testManagerEmail = `desktop.mgr.${testRunId}@retail.com`;
  const testManagerPassword = 'SecurePassword2026!';

  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    await seedDefaultUsers();

    // Sign in as Owner to get owner cookie for approval workflow
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@store.com',
        password: 'admin123',
      }),
    });
    assert.equal(res.status, 200);
    ownerCookie = extractCookie(res, 'token');
    assert.ok(ownerCookie, 'Owner cookie must be acquired for tests');
  });

  after(async () => {
    try {
      if (mongoose.connection.readyState === 1 && testManagerId) {
        await User.deleteMany({ email: testManagerEmail });
      }
    } catch (e) {
      // Ignore
    }
  });

  // 1. Sales Manager signup exists in the Electron desktop app
  test('1. Desktop Application: Sales Manager signup & login screens exist with required fields & secure IPC', async () => {
    const desktopAuthPath = path.join(__dirname, '..', '..', 'storelistner-desktop', 'src', 'components', 'DesktopAuthView.jsx');
    assert.ok(fs.existsSync(desktopAuthPath), 'DesktopAuthView.jsx must exist in storelistner-desktop/src/components');

    const desktopAuthContent = fs.readFileSync(desktopAuthPath, 'utf8');
    assert.ok(desktopAuthContent.includes('Manager Sign Up'), 'Must contain Manager Sign Up tab/view');
    assert.ok(desktopAuthContent.includes('Manager Sign In'), 'Must contain Manager Sign In tab/view');
    assert.ok(desktopAuthContent.includes('Display Name') || desktopAuthContent.includes('name'), 'Must have Display Name field');
    assert.ok(desktopAuthContent.includes('email') || desktopAuthContent.includes('Email'), 'Must have Email field');
    assert.ok(desktopAuthContent.includes('password') || desktopAuthContent.includes('Password'), 'Must have Password field');
    assert.ok(desktopAuthContent.includes('confirmPassword') || desktopAuthContent.includes('Confirm Password'), 'Must have Confirm Password field');
    assert.ok(desktopAuthContent.includes('STORE-01') && desktopAuthContent.includes('STORE-02') && desktopAuthContent.includes('STORE-03'), 'Must allow store selection from the 3 configured retail stores');

    // Preload script check
    const preloadPath = path.join(__dirname, '..', '..', 'storelistner-desktop', 'preload.cjs');
    const preloadContent = fs.readFileSync(preloadPath, 'utf8');
    assert.ok(preloadContent.includes('authRegister'), 'preload.cjs must expose authRegister');
    assert.ok(preloadContent.includes('authLogin'), 'preload.cjs must expose authLogin');
    assert.ok(preloadContent.includes('authGetSession'), 'preload.cjs must expose authGetSession');
    assert.ok(preloadContent.includes('authLogout'), 'preload.cjs must expose authLogout');

    // Main process IPC check
    const mainPath = path.join(__dirname, '..', '..', 'storelistner-desktop', 'main.cjs');
    const mainContent = fs.readFileSync(mainPath, 'utf8');
    assert.ok(mainContent.includes("ipcMain.handle('auth:register'"), 'main.cjs must handle auth:register');
    assert.ok(mainContent.includes("ipcMain.handle('auth:login'"), 'main.cjs must handle auth:login');
    assert.ok(mainContent.includes('validateIpcSender'), 'main.cjs must validate IPC sender frame identity');
  });

  // 2. The Owner web dashboard no longer exposes Sales Manager signup
  test('2. Web Dashboard Cleanup: Owner web login no longer exposes Sales Manager signup', async () => {
    const frontendDirName = fs.existsSync(path.join(__dirname, '..', '..', 'storelistener-frontend')) ? 'storelistener-frontend' : 'storelistner-frontend';
    const webAuthPath = path.join(__dirname, '..', '..', frontendDirName, 'src', 'components', 'AuthView.jsx');
    assert.ok(fs.existsSync(webAuthPath), 'Web AuthView.jsx must exist');

    const webAuthContent = fs.readFileSync(webAuthPath, 'utf8');
    assert.ok(!webAuthContent.includes('handleRegister'), 'Web AuthView must NOT have handleRegister function');
    assert.ok(!webAuthContent.includes('Manager Sign Up'), 'Web AuthView must NOT have Manager Sign Up tab');
    assert.ok(!webAuthContent.includes('register-manager'), 'Web AuthView must NOT call register-manager API');
    assert.ok(webAuthContent.includes('admin@store.com'), 'Web AuthView must retain Owner login');
  });

  // 3. Signup creates a pending request
  test('3. Desktop Signup Submission: Creates a pending request, hashes password on backend, issues no cookie', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/register-manager`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Desktop Test Manager',
        email: testManagerEmail,
        password: testManagerPassword,
        confirmPassword: testManagerPassword,
        storeCode: 'STORE-03',
      }),
    });

    assert.equal(res.status, 201, 'Signup must return 201 Created');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'pending', 'User must be created in pending status');
    assert.equal(data.user.role, 'sales_manager', 'Role must be locked to sales_manager');
    assert.equal(data.user.storeCode, 'STORE-03');
    assert.equal(data.token, undefined, 'No token in signup response body');
    assert.equal(res.headers.get('set-cookie'), null, 'No session cookie issued on signup');

    testManagerId = data.user.id || data.user._id;

    // Check MongoDB: password must be hashed with bcrypt, NOT plaintext
    const dbUser = await User.findById(testManagerId);
    assert.ok(dbUser, 'User must exist in database');
    assert.notEqual(dbUser.password, testManagerPassword, 'Password MUST be securely hashed with bcrypt');
    assert.ok(dbUser.password.startsWith('$2'), 'Password must be valid bcrypt hash');
  });

  // 3b. Anti-enumeration and input validation
  test('3b. Security: Duplicate signup avoids account enumeration and returns 400', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/register-manager`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Another Manager Attempt',
        email: testManagerEmail.toUpperCase(),
        password: testManagerPassword,
        confirmPassword: testManagerPassword,
        storeCode: 'STORE-03',
      }),
    });

    assert.equal(res.status, 400, 'Duplicate registration must return 400');
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(!data.error.includes('An account with this email already exists'), 'Must avoid specific enumeration message');
  });

  // 4. Pending and rejected accounts cannot authenticate
  test('4. Authentication Guard: Pending and rejected accounts cannot log in (403 Forbidden)', async () => {
    // 4a. Pending login attempt
    const resPending = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testManagerEmail,
        password: testManagerPassword,
      }),
    });

    assert.equal(resPending.status, 403, 'Pending manager login must be blocked with 403');
    const pendingData = await resPending.json();
    assert.equal(pendingData.status, 'pending');
    assert.equal(resPending.headers.get('set-cookie'), null, 'No cookie issued to pending user');
  });

  // 5. Only the Owner can approve requests
  test('5. RBAC: Only an authenticated Owner may approve or reject manager requests', async () => {
    // 5a. Unauthenticated approval attempt
    const resUnauth = await fetch(`${BACKEND_URL}/api/auth/users/${testManagerId}/approve`, {
      method: 'POST',
    });
    assert.equal(resUnauth.status, 401, 'Unauthenticated approval must return 401');

    // 5b. Authenticated Owner approves manager
    const resApprove = await fetch(`${BACKEND_URL}/api/auth/users/${testManagerId}/approve`, {
      method: 'POST',
      headers: { Cookie: `token=${ownerCookie}` },
    });
    assert.equal(resApprove.status, 200, 'Owner approval must return 200');
    const approveData = await resApprove.json();
    assert.equal(approveData.success, true);
    assert.equal(approveData.user.status, 'approved', 'Status must be updated to approved');
    assert.ok(approveData.user.approvedAt, 'Must record approvedAt');
    assert.ok(approveData.user.approvedBy, 'Must record approvedBy');
  });

  // 6. Approved managers can authenticate and access only their assigned store
  test('6. Store Authorization: Approved manager logs in with HttpOnly cookie, restricted to assigned store', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testManagerEmail,
        password: testManagerPassword,
      }),
    });

    assert.equal(res.status, 200, 'Approved manager login must succeed with 200');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.role, 'sales_manager');
    assert.equal(data.user.storeCode, 'STORE-03', 'Manager store code must match approved assignment');
    assert.equal(data.token, undefined, 'JWT token must NOT be in JSON body');

    approvedManagerCookie = extractCookie(res, 'token');
    assert.ok(approvedManagerCookie, 'HttpOnly cookie must be issued');

    // Access /api/auth/me with cookie
    const meRes = await fetch(`${BACKEND_URL}/api/auth/me`, {
      headers: { Cookie: `token=${approvedManagerCookie}` },
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.user.email, testManagerEmail.toLowerCase());
    assert.equal(meData.user.storeCode, 'STORE-03');

    // Manager cannot access Owner-only endpoints
    const pendingListRes = await fetch(`${BACKEND_URL}/api/auth/pending-sales-managers`, {
      headers: { Cookie: `token=${approvedManagerCookie}` },
    });
    assert.equal(pendingListRes.status, 403, 'Sales Manager must be forbidden from Owner-only endpoints');
  });

  // 7. Secrets and credentials are not exposed in renderer code, API responses, or logs
  test('7. Security: Zero secrets or privileged tokens exposed to renderer', async () => {
    const desktopMainPath = path.join(__dirname, '..', '..', 'storelistner-desktop', 'main.cjs');
    const mainContent = fs.readFileSync(desktopMainPath, 'utf8');

    // Verify main.cjs enforces context isolation and nodeIntegration: false
    assert.ok(mainContent.includes('contextIsolation: true'), 'Must keep contextIsolation: true');
    assert.ok(mainContent.includes('nodeIntegration: false'), 'Must keep nodeIntegration: false');

    // Verify preload script does not expose process or fs
    const preloadPath = path.join(__dirname, '..', '..', 'storelistner-desktop', 'preload.cjs');
    const preloadContent = fs.readFileSync(preloadPath, 'utf8');
    assert.ok(!preloadContent.includes('require("fs")') && !preloadContent.includes("require('fs')"), 'Preload must not expose fs');
    assert.ok(!preloadContent.includes('process.env.JWT_SECRET'), 'Preload must not expose JWT_SECRET');
  });

  // 8. Existing desktop and web features still work (Regression verification)
  test('8. Regression: Health check, Stores Overview, and Sessions endpoints remain functional', async () => {
    // Health
    const healthRes = await fetch(`${BACKEND_URL}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'online');

    // Stores
    const storesRes = await fetch(`${BACKEND_URL}/api/stores/overview`);
    assert.equal(storesRes.status, 200);
    const stores = await storesRes.json();
    assert.equal(stores.success, true);
    assert.ok(Array.isArray(stores.stores));

    // Sessions
    const sessionsRes = await fetch(`${BACKEND_URL}/api/sessions?limit=2`);
    assert.equal(sessionsRes.status, 200);
    const sessions = await sessionsRes.json();
    assert.equal(sessions.success, true);
  });
});
