const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendSms } = require('../services/sms');

const router = express.Router();
const PAGE_SIZE = 20;

router.get('/sms-logs', requireAuth, async (req, res) => {
  const { keyword = '', type = '', status = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);

  const conditions = [];
  const params = [];

  if (keyword) {
    conditions.push('s.name LIKE ?');
    params.push(`%${keyword}%`);
  }
  if (type) {
    conditions.push('sl.template_type = ?');
    params.push(type);
  }
  if (status) {
    conditions.push('sl.send_status = ?');
    params.push(status);
  }
  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = await db.get(`
    SELECT COUNT(*) as cnt FROM sms_log sl JOIN student s ON s.id = sl.student_id ${whereClause}
  `, params);
  const total = totalRow.cnt;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const logs = await db.all(`
    SELECT sl.*, s.name as student_name
    FROM sms_log sl
    JOIN student s ON s.id = sl.student_id
    ${whereClause}
    ORDER BY sl.sent_at DESC
    LIMIT ? OFFSET ?
  `, [...params, PAGE_SIZE, offset]);

  const overallStats = await db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN send_status='success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN send_status='failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN template_type='charge_notice' THEN 1 ELSE 0 END) as charge_notice_count,
      SUM(CASE WHEN template_type='overdue_notice' THEN 1 ELSE 0 END) as overdue_notice_count
    FROM sms_log
  `);

  res.render('sms-logs/index', {
    pageTitle: 'SMS 발송 로그',
    active: 'sms-logs',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    logs,
    overallStats,
    filters: { keyword, type, status },
    pagination: { page: safePage, totalPages, total },
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

router.post('/sms-logs/:id/resend', requireAuth, async (req, res) => {
  const log = await db.get('SELECT * FROM sms_log WHERE id = ?', [req.params.id]);
  if (!log) {
    return res.redirect('/sms-logs?flash=' + encodeURIComponent('로그를 찾을 수 없습니다.') + '&flashType=error');
  }

  await sendSms({
    chargeId: log.charge_id,
    studentId: log.student_id,
    templateType: log.template_type,
    recipientPhone: log.recipient_phone,
    messageContent: log.message_content,
    sentBy: req.session.adminId,
  });

  res.redirect('/sms-logs?flash=' + encodeURIComponent('재발송 처리되었습니다.'));
});

module.exports = router;
