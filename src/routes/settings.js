const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getSetting, setSetting } = require('../services/sms');

const router = express.Router();

router.get('/settings', requireAuth, (req, res) => {
  const accountInfo = getSetting('account_info', '');
  const smsApiProvider = getSetting('sms_api_provider', 'aligo');
  const smsApiKey = getSetting('sms_api_key', '');
  const smsSenderNumber = getSetting('sms_sender_number', '');

  const templates = db.prepare('SELECT * FROM sms_template ORDER BY type').all();
  const admins = db.prepare('SELECT id, username, display_name, role, is_active, created_at FROM admin_user ORDER BY id').all();

  res.render('settings/index', {
    pageTitle: '설정',
    active: 'settings',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    currentAdminId: req.session.adminId,
    accountInfo,
    smsApiProvider,
    smsApiKey,
    smsSenderNumber,
    templates,
    admins,
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

// ---------- 학원 계좌정보 저장 ----------
router.post('/settings/account', requireAuth, (req, res) => {
  const { account_info } = req.body;
  if (!account_info || !account_info.trim()) {
    return res.redirect('/settings?flash=' + encodeURIComponent('계좌정보를 입력해주세요.') + '&flashType=error');
  }
  setSetting('account_info', account_info.trim());
  res.redirect('/settings?flash=' + encodeURIComponent('학원 계좌정보가 저장되었습니다. 이후 발송되는 SMS에 즉시 반영됩니다.'));
});

// ---------- SMS API 설정 저장 (실제 외부 연동은 3단계에서 처리, 여기서는 저장만) ----------
router.post('/settings/sms-api', requireAuth, (req, res) => {
  const { sms_api_provider, sms_api_key, sms_sender_number } = req.body;
  setSetting('sms_api_provider', sms_api_provider || '');
  setSetting('sms_api_key', sms_api_key || '');
  setSetting('sms_sender_number', sms_sender_number || '');
  res.redirect('/settings?flash=' + encodeURIComponent('SMS API 설정이 저장되었습니다. (※ 실제 외부 API 연동은 다음 단계에서 구현됩니다. 현재는 발송 시뮬레이션으로 동작합니다.)'));
});

// ---------- 문자 템플릿 수정 ----------
router.post('/settings/templates/:id', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.redirect('/settings?flash=' + encodeURIComponent('템플릿 내용을 입력해주세요.') + '&flashType=error');
  }
  db.prepare('UPDATE sms_template SET content = ? WHERE id = ?').run(content, req.params.id);
  res.redirect('/settings?flash=' + encodeURIComponent('문자 템플릿이 저장되었습니다.'));
});

// ---------- 관리자 비밀번호 변경 (본인 계정만) ----------
router.post('/settings/change-password', requireAuth, (req, res) => {
  const { current_password, new_password, new_password_confirm } = req.body;

  const admin = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(req.session.adminId);

  if (!bcrypt.compareSync(current_password, admin.password_hash)) {
    return res.redirect('/settings?flash=' + encodeURIComponent('현재 비밀번호가 올바르지 않습니다.') + '&flashType=error');
  }
  if (!new_password || new_password.length < 4) {
    return res.redirect('/settings?flash=' + encodeURIComponent('새 비밀번호는 4자 이상이어야 합니다.') + '&flashType=error');
  }
  if (new_password !== new_password_confirm) {
    return res.redirect('/settings?flash=' + encodeURIComponent('새 비밀번호가 일치하지 않습니다.') + '&flashType=error');
  }

  const newHash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE admin_user SET password_hash = ? WHERE id = ?').run(newHash, admin.id);

  res.redirect('/settings?flash=' + encodeURIComponent('비밀번호가 변경되었습니다.'));
});

module.exports = router;
