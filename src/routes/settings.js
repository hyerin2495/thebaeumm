const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getSetting, setSetting } = require('../services/sms');

const router = express.Router();

router.get('/settings', requireAuth, async (req, res) => {
  const accountInfo = await getSetting('account_info', '');
  const smsApiProvider = await getSetting('sms_api_provider', 'aligo');
  const smsApiKey = await getSetting('sms_api_key', '');
  const smsSenderNumber = await getSetting('sms_sender_number', '');

  const templates = await db.all('SELECT * FROM sms_template ORDER BY type');
  const admins = await db.all('SELECT id, username, display_name, role, is_active, created_at FROM admin_user ORDER BY id');

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

router.post('/settings/account', requireAuth, async (req, res) => {
  const { account_info } = req.body;
  if (!account_info || !account_info.trim()) {
    return res.redirect('/settings?flash=' + encodeURIComponent('계좌정보를 입력해주세요.') + '&flashType=error');
  }
  await setSetting('account_info', account_info.trim());
  res.redirect('/settings?flash=' + encodeURIComponent('학원 계좌정보가 저장되었습니다. 이후 발송되는 SMS에 즉시 반영됩니다.'));
});

router.post('/settings/sms-api', requireAuth, async (req, res) => {
  const { sms_api_provider, sms_api_key, sms_sender_number } = req.body;
  await setSetting('sms_api_provider', sms_api_provider || '');
  await setSetting('sms_api_key', sms_api_key || '');
  await setSetting('sms_sender_number', sms_sender_number || '');
  res.redirect('/settings?flash=' + encodeURIComponent('SMS API 설정이 저장되었습니다.'));
});

router.post('/settings/templates/:id', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.redirect('/settings?flash=' + encodeURIComponent('템플릿 내용을 입력해주세요.') + '&flashType=error');
  }
  await db.run('UPDATE sms_template SET content = ? WHERE id = ?', [content, req.params.id]);
  res.redirect('/settings?flash=' + encodeURIComponent('문자 템플릿이 저장되었습니다.'));
});

router.post('/settings/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password, new_password_confirm } = req.body;

  const admin = await db.get('SELECT * FROM admin_user WHERE id = ?', [req.session.adminId]);

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
  await db.run('UPDATE admin_user SET password_hash = ? WHERE id = ?', [newHash, admin.id]);

  res.redirect('/settings?flash=' + encodeURIComponent('비밀번호가 변경되었습니다.'));
});

module.exports = router;
