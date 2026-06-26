const db = require('../db');

const DEFAULT_ACCOUNT_INFO = '농협 123-456-789012 (더배움영수학원)';

async function getSetting(key, fallback = null) {
  const row = await db.get('SELECT `value` FROM app_setting WHERE `key` = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await db.run(
    'INSERT INTO app_setting (`key`, `value`, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = NOW()',
    [key, value]
  );
}

async function getAccountInfo() {
  return getSetting('account_info', DEFAULT_ACCOUNT_INFO);
}

function renderTemplate(content, vars) {
  return content
    .replace(/\{학생명\}/g, vars.studentName || '')
    .replace(/\{교재명\}/g, vars.bookNames || '')
    .replace(/\{금액\}/g, vars.amount != null ? vars.amount.toLocaleString() : '')
    .replace(/\{계좌\}/g, vars.account || '')
    .replace(/\{기한\}/g, vars.dueDate || '');
}

async function sendSms({ chargeId, studentId, templateType, recipientPhone, messageContent, sentBy }) {
  const result = await db.run(
    `INSERT INTO sms_log (charge_id, student_id, template_type, recipient_phone, message_content, send_status, fail_reason, sent_by, sent_at)
     VALUES (?, ?, ?, ?, ?, 'success', NULL, ?, NOW())`,
    [chargeId, studentId, templateType, recipientPhone, messageContent, sentBy || null]
  );
  return db.get('SELECT * FROM sms_log WHERE id = ?', [result.insertId]);
}

async function getDefaultTemplate(type) {
  return db.get('SELECT * FROM sms_template WHERE type = ? AND is_default = 1', [type]);
}

module.exports = { renderTemplate, sendSms, getDefaultTemplate, getAccountInfo, getSetting, setSetting };
