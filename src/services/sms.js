const db = require('../db');

const DEFAULT_ACCOUNT_INFO = '농협 123-456-789012 (더배움영수학원)';

/**
 * 설정값 조회 (app_setting 테이블). 없으면 기본값 반환.
 */
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function getAccountInfo() {
  return getSetting('account_info', DEFAULT_ACCOUNT_INFO);
}

/**
 * 변수 치환 (템플릿 {학생명}{교재명}{금액}{계좌}{기한} 등)
 */
function renderTemplate(content, vars) {
  return content
    .replace(/\{학생명\}/g, vars.studentName || '')
    .replace(/\{교재명\}/g, vars.bookNames || '')
    .replace(/\{금액\}/g, vars.amount != null ? vars.amount.toLocaleString() : '')
    .replace(/\{계좌\}/g, vars.account || getAccountInfo())
    .replace(/\{기한\}/g, vars.dueDate || '');
}

/**
 * SMS 발송 시뮬레이션.
 * 실제 알리고 등 API 연동은 3단계에서 처리. 지금은 로그만 기록하고
 * 항상 성공으로 처리한다 (데모/시연 목적).
 *
 * @returns {Object} 생성된 sms_log row
 */
function sendSms({ chargeId, studentId, templateType, recipientPhone, messageContent, sentBy }) {
  const result = db.prepare(`
    INSERT INTO sms_log (charge_id, student_id, template_type, recipient_phone, message_content, send_status, fail_reason, sent_by, sent_at)
    VALUES (?, ?, ?, ?, ?, 'success', NULL, ?, datetime('now'))
  `).run(chargeId, studentId, templateType, recipientPhone, messageContent, sentBy || null);

  return db.prepare('SELECT * FROM sms_log WHERE id = ?').get(result.lastInsertRowid);
}

function getDefaultTemplate(type) {
  return db.prepare('SELECT * FROM sms_template WHERE type = ? AND is_default = 1').get(type);
}

module.exports = { renderTemplate, sendSms, getDefaultTemplate, getAccountInfo, getSetting, setSetting, ACCOUNT_INFO: DEFAULT_ACCOUNT_INFO };
