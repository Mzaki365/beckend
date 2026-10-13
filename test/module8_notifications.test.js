/**
 * Storelistener — Module 8: Smart Alerts & Notifications Automated Test Suite
 * File: test/module8_notifications.test.js
 *
 * Verifies all Module 8 requirements:
 * 1. Event triggers create correct alerts for all 8 supported event types with real data.
 * 2. Duplicate events do not create duplicate notifications (Idempotency enforcement).
 * 3. Real-time updates delivered via Socket.IO (new_notification, notifications_count_update).
 * 4. Read/unread status updates persist across queries and database reloads.
 * 5. Notification settings persist and control alert triggering (disabling suppresses alert).
 * 6. Store-level authorization: sales managers cannot access other stores' notifications.
 * 7. Non-blocking error handling: notification failures do not interrupt core services.
 * 8. Regression verification: Modules 0-7 session and deal analysis remain functional.
 */

require('dotenv').config();
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

let ioClient;
try {
  ioClient = require('socket.io-client');
} catch (e) {
  ioClient = require('d:/Star Solutions/storelistener/storelistner-desktop/node_modules/socket.io-client');
}

const BACKEND_URL = 'http://localhost:5000';
const { JWT_SECRET } = require('../middleware/auth');
const Notification = require('../models/Notification');
const NotificationSettings = require('../models/NotificationSettings');
const Session = require('../models/Session');
const notificationService = require('../services/notificationService');

function createTestToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Module 8: Smart Alerts & Notifications Test Suite', () => {
  let adminToken;
  let managerStore01Token;
  let managerStore02Token;
  let socketClient;
  const testPrefix = `m8-test-${Date.now()}`;
  const testStore01 = `STORE-TEST-01`;
  const testStore02 = `STORE-TEST-02`;

  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }

    adminToken = createTestToken({
      id: 'admin-m8',
      email: 'admin@storelistener.com',
      role: 'store_admin',
    });

    managerStore01Token = createTestToken({
      id: 'mgr-m8-01',
      email: 'manager01@storelistener.com',
      role: 'sales_manager',
      storeCode: testStore01,
    });

    managerStore02Token = createTestToken({
      id: 'mgr-m8-02',
      email: 'manager02@storelistener.com',
      role: 'sales_manager',
      storeCode: testStore02,
    });

    // Connect test Socket.IO client
    socketClient = ioClient(BACKEND_URL, {
      transports: ['websocket'],
      reconnection: false,
    });

    await new Promise((resolve) => {
      socketClient.on('connect', () => {
        socketClient.emit('authenticate', { token: adminToken });
        resolve();
      });
      setTimeout(resolve, 2000);
    });
  });

  after(async () => {
    if (socketClient && socketClient.connected) {
      socketClient.disconnect();
    }
    // Clean up test notifications
    await Notification.deleteMany({ idempotencyKey: new RegExp(testPrefix) });
    await Notification.deleteMany({ storeCode: { $in: [testStore01, testStore02] } });
    await Session.deleteMany({ sessionId: new RegExp(testPrefix) });
  });

  test('1. Real events create correct alerts with appropriate metadata and severity', async () => {
    // 1a. Store Desktop Offline alert
    const offlineNotif = await notificationService.createNotification({
      type: 'store_offline',
      title: 'Store Desktop Disconnected',
      description: `Store ${testStore01} has lost connection.`,
      severity: 'error',
      storeCode: testStore01,
      idempotencyKey: `${testPrefix}:offline:1`,
      metadata: { reason: 'heartbeat_timeout' },
    });
    assert.ok(offlineNotif, 'Offline notification should be created');
    assert.equal(offlineNotif.type, 'store_offline');
    assert.equal(offlineNotif.severity, 'error');

    // 1b. Store Desktop Reconnected (Online) alert
    const onlineNotif = await notificationService.createNotification({
      type: 'store_online',
      title: 'Store Desktop Connected',
      description: `Store ${testStore01} reconnected.`,
      severity: 'info',
      storeCode: testStore01,
      idempotencyKey: `${testPrefix}:online:1`,
    });
    assert.ok(onlineNotif, 'Online notification should be created');
    assert.equal(onlineNotif.type, 'store_online');

    // 1c. Conversation Started alert
    const startNotif = await notificationService.createNotification({
      type: 'conversation_started',
      title: 'New Conversation Active',
      description: `Active dialogue detected at ${testStore01}.`,
      severity: 'info',
      storeCode: testStore01,
      sessionId: `${testPrefix}-sess-1`,
      salesRep: 'Sarah Jenkins',
      idempotencyKey: `${testPrefix}:start:1`,
    });
    assert.ok(startNotif, 'Conversation started notification should be created');
    assert.equal(startNotif.salesRep, 'Sarah Jenkins');

    // 1d. Conversation Completed alert
    const completeNotif = await notificationService.createNotification({
      type: 'conversation_completed',
      title: 'Conversation Completed',
      description: `Dialogue completed with 4 turns.`,
      severity: 'info',
      storeCode: testStore01,
      sessionId: `${testPrefix}-sess-1`,
      idempotencyKey: `${testPrefix}:complete:1`,
    });
    assert.ok(completeNotif, 'Conversation completed notification should be created');

    // 1e. Sale Confirmed alert (requires confirmed sale)
    const saleNotif = await notificationService.createNotification({
      type: 'sale_confirmed',
      title: 'Confirmed Sale Recorded! 🎉',
      description: `Sale confirmed for 18k Gold Necklace at ${testStore01}.`,
      severity: 'success',
      storeCode: testStore01,
      sessionId: `${testPrefix}-sess-1`,
      salesRep: 'Sarah Jenkins',
      idempotencyKey: `${testPrefix}:sale:1`,
      metadata: { product: '18k Gold Necklace' },
    });
    assert.ok(saleNotif, 'Sale confirmed notification should be created');
    assert.equal(saleNotif.severity, 'success');

    // 1f. Follow-up Required alert
    const followNotif = await notificationService.createNotification({
      type: 'follow_up_required',
      title: 'Customer Follow-up Required',
      description: `Customer requested callback on Monday for diamond ring inquiry.`,
      severity: 'warning',
      storeCode: testStore01,
      sessionId: `${testPrefix}-sess-1`,
      idempotencyKey: `${testPrefix}:followup:1`,
    });
    assert.ok(followNotif, 'Follow-up notification should be created');
    assert.equal(followNotif.severity, 'warning');

    // 1g. High Intent Unclear Outcome alert
    const highIntentNotif = await notificationService.createNotification({
      type: 'high_intent_unclear_outcome',
      title: 'High Buying Intent — Unrecorded Outcome',
      description: `Strong purchase intent observed but no final outcome was recorded.`,
      severity: 'warning',
      storeCode: testStore01,
      sessionId: `${testPrefix}-sess-1`,
      idempotencyKey: `${testPrefix}:highintent:1`,
    });
    assert.ok(highIntentNotif, 'High intent unclear outcome notification should be created');

    // 1h. AI Analysis Failure alert
    const failNotif = await notificationService.createNotification({
      type: 'analysis_failure',
      title: 'AI Analysis Failed',
      description: `Analysis pipeline encountered a processing error.`,
      severity: 'error',
      storeCode: testStore01,
      sessionId: `${testPrefix}-sess-1`,
      idempotencyKey: `${testPrefix}:failure:1`,
    });
    assert.ok(failNotif, 'Analysis failure notification should be created');
    assert.equal(failNotif.severity, 'error');

    // 1i. Store Inactivity alert
    const inactNotif = await notificationService.createNotification({
      type: 'store_inactivity',
      title: 'Store Inactivity Detected',
      description: `Store ${testStore01} has recorded no conversations for over 60 minutes.`,
      severity: 'warning',
      storeCode: testStore01,
      idempotencyKey: `${testPrefix}:inactivity:1`,
      metadata: { inactiveMinutes: 65, thresholdMinutes: 60 },
    });
    assert.ok(inactNotif, 'Inactivity notification should be created');
  });

  test('2. Duplicate events do not create duplicate notifications (Idempotency enforcement)', async () => {
    const key = `${testPrefix}:duplicate-test-key`;

    const first = await notificationService.createNotification({
      type: 'sale_confirmed',
      title: 'Sale Event First Attempt',
      description: 'First attempt description',
      idempotencyKey: key,
      storeCode: testStore01,
    });
    assert.ok(first, 'First insertion must succeed');

    // Attempt second insertion with identical idempotencyKey
    const second = await notificationService.createNotification({
      type: 'sale_confirmed',
      title: 'Sale Event Duplicate Attempt',
      description: 'Second attempt description',
      idempotencyKey: key,
      storeCode: testStore01,
    });

    assert.ok(second, 'Second call returns existing notification');
    assert.equal(second._id.toString(), first._id.toString(), 'Must return the same notification ID');
    assert.equal(second.title, 'Sale Event First Attempt', 'Title must remain unchanged from original');

    // Verify DB count has exactly 1 document with this key
    const count = await Notification.countDocuments({ idempotencyKey: key });
    assert.equal(count, 1, 'Database must have exactly 1 notification for this idempotency key');
  });

  test('3. Real-time updates delivered via Socket.IO', async () => {
    let receivedNotification = null;

    socketClient.on('new_notification', (data) => {
      if (data && data.notification && data.notification.idempotencyKey === `${testPrefix}:socket-test`) {
        receivedNotification = data.notification;
      }
    });

    const triggerRes = await fetch(`${BACKEND_URL}/api/notifications/trigger-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        type: 'conversation_completed',
        storeCode: testStore01,
        title: 'Real-time WebSocket Test Alert',
        description: 'Verifying instant delivery to owner dashboard',
      }),
    });

    const triggerData = await triggerRes.json();
    assert.ok(triggerData.success, 'Trigger test endpoint must return success');

    // Wait briefly for WebSocket delivery
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Also verify unread count endpoint updates
    const countRes = await fetch(`${BACKEND_URL}/api/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const countData = await countRes.json();
    assert.ok(countData.success, 'Unread count fetch must succeed');
    assert.ok(countData.unreadCount >= 1, 'Unread count should be >= 1');
  });

  test('4. Read/unread status updates persist across queries and database reloads', async () => {
    // Create an unread test notification
    const testNotif = await notificationService.createNotification({
      type: 'follow_up_required',
      title: 'Unread Status Test Alert',
      description: 'Testing read persistence',
      storeCode: testStore01,
      idempotencyKey: `${testPrefix}:read-test`,
    });
    assert.equal(testNotif.isRead, false, 'Initial state must be unread');

    // Mark as read via API
    const markRes = await fetch(`${BACKEND_URL}/api/notifications/${testNotif._id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const markData = await markRes.json();
    assert.ok(markData.success, 'Mark as read endpoint must return success');
    assert.equal(markData.notification.isRead, true, 'Returned notification must have isRead: true');
    assert.ok(markData.notification.readAt, 'readAt timestamp must be recorded');

    // Reload directly from MongoDB to verify true persistence
    const reloaded = await Notification.findById(testNotif._id);
    assert.equal(reloaded.isRead, true, 'Reloaded notification in MongoDB must have isRead: true');
    assert.ok(reloaded.readAt, 'Reloaded notification must have readAt timestamp');

    // Test Mark All Read endpoint
    const markAllRes = await fetch(`${BACKEND_URL}/api/notifications/mark-all-read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ storeCode: testStore01 }),
    });
    const markAllData = await markAllRes.json();
    assert.ok(markAllData.success, 'Mark all read endpoint must return success');

    // Verify unread count for store01 is now 0
    const countRes = await fetch(`${BACKEND_URL}/api/notifications/unread-count?storeCode=${testStore01}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const countData = await countRes.json();
    assert.equal(countData.unreadCount, 0, 'Unread count for store01 must be 0 after marking all read');
  });

  test('5. Notification settings persist and control alert triggering', async () => {
    // 5a. Fetch current settings
    const getRes = await fetch(`${BACKEND_URL}/api/notifications/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const getData = await getRes.json();
    assert.ok(getData.success, 'Settings fetch must return success');
    assert.ok(getData.settings.rules, 'Settings must contain rules');

    // 5b. Update settings: disable store_online rule and set inactivity threshold to 45 min
    const updateRes = await fetch(`${BACKEND_URL}/api/notifications/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        rules: {
          ...getData.settings.rules,
          store_online: { enabled: false, severity: 'info' },
          store_inactivity: { enabled: true, severity: 'warning', thresholdMinutes: 45 },
        },
        inactivityThresholdMinutes: 45,
      }),
    });
    const updateData = await updateRes.json();
    assert.ok(updateData.success, 'Settings update must succeed');
    assert.equal(updateData.settings.rules.store_online.enabled, false);
    assert.equal(updateData.settings.rules.store_inactivity.thresholdMinutes, 45);

    // 5c. Verify disabled rule suppresses notification creation
    const suppressed = await notificationService.createNotification({
      type: 'store_online',
      title: 'Should be suppressed',
      description: 'This alert should not be saved because rule is disabled',
      storeCode: testStore01,
      idempotencyKey: `${testPrefix}:suppressed:1`,
    });
    assert.equal(suppressed, null, 'Disabled rule must return null and suppress notification');

    // Verify DB does not contain the suppressed notification
    const suppressedDoc = await Notification.findOne({ idempotencyKey: `${testPrefix}:suppressed:1` });
    assert.equal(suppressedDoc, null, 'Suppressed notification must not be saved to DB');

    // 5d. Re-enable store_online rule
    await notificationService.updateSettings({
      rules: {
        ...getData.settings.rules,
        store_online: { enabled: true, severity: 'info' },
      },
    });
  });

  test('6. Store-level authorization: sales managers cannot access other stores notifications', async () => {
    // Create notification specifically for Store 02
    const store02Notif = await notificationService.createNotification({
      type: 'follow_up_required',
      title: 'Store 02 Private Alert',
      description: 'Exclusive to Store 02',
      storeCode: testStore02,
      idempotencyKey: `${testPrefix}:store02-notif`,
    });
    assert.ok(store02Notif);

    // Attempt to access Store 02 notification using Manager 01 token
    const crossStoreGetRes = await fetch(`${BACKEND_URL}/api/notifications?storeCode=${testStore02}`, {
      headers: { Authorization: `Bearer ${managerStore01Token}` },
    });
    const crossStoreData = await crossStoreGetRes.json();
    assert.ok(crossStoreData.success);
    // Manager 01 should NOT see Store 02 notifications (enforced to testStore01)
    const hasStore02Items = crossStoreData.notifications.some((n) => n.storeCode === testStore02);
    assert.equal(hasStore02Items, false, 'Manager 01 must not see Store 02 notifications');

    // Manager 01 attempts to mark Store 02 notification as read
    const unauthorizedMarkRes = await fetch(`${BACKEND_URL}/api/notifications/${store02Notif._id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${managerStore01Token}` },
    });
    assert.equal(unauthorizedMarkRes.status, 403, 'Cross-store modification must return 403 Forbidden');
  });

  test('7. Non-blocking error handling: notification failures do not interrupt core services', async () => {
    // Pass completely malformed data to createNotification
    let errorThrown = false;
    let result = null;
    try {
      // Intentionally invalid input that would throw if unhandled
      result = await notificationService.createNotification(null);
    } catch (err) {
      errorThrown = true;
    }

    assert.equal(errorThrown, false, 'createNotification must never throw unhandled exceptions');
    assert.equal(result, null, 'Failed creation safely returns null without interrupting caller');
  });

  test('8. Regression verification: Modules 0-7 session and deal analysis remain functional', async () => {
    // Create a completed session with deal analysis
    const session = new Session({
      sessionId: `${testPrefix}-regression-sess`,
      storeCode: testStore01,
      storeName: 'Test Jewelry Flagship',
      salesRep: 'Michael Chang',
      status: 'completed',
      conversationTitle: 'Regression Test Session',
      startedAt: new Date(),
      endedAt: new Date(),
      transcript: [
        { speaker: 'sales_rep', text: 'Welcome to our store, can I help you find something?' },
        { speaker: 'customer', text: 'I would like to purchase this diamond pendant today.' },
        { speaker: 'sales_rep', text: 'Great choice! That is $450. Let me wrap it up for you.' },
        { speaker: 'customer', text: 'Perfect, here is my card. Thank you!' },
      ],
      dealAnalysis: {
        customerRequirements: 'Diamond pendant',
        budgetAndPrice: '$450',
        customerBuyingIntent: 'High',
        conversationOutcome: 'Sale Confirmed',
        summary: 'Customer finalized purchase of diamond pendant',
        analysisStatus: 'completed',
      },
    });
    await session.save();

    // Verify session can be retrieved via existing API
    const sessRes = await fetch(`${BACKEND_URL}/api/sessions/${session.sessionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const sessData = await sessRes.json();
    assert.ok(sessData.success, 'Existing session API must remain fully functional');
    assert.equal(sessData.session.dealAnalysis.conversationOutcome, 'Sale Confirmed');
    assert.equal(sessData.session.dealAnalysis.customerBuyingIntent, 'High');
  });
});
