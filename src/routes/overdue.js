const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { renderTemplate, sendSms, getDefaultTemplate, getAccountInfo } = require('../services/sms');
const { detectOverdue } = require('../services/overdueBatch');

const router = express.Router();

function buildOverdueMessage(charge) {
  const items = db.prepare(`
    SELECT ci.quantity, bk.name FROM charge_item ci JOIN book bk ON bk.id = ci.book_id WHERE ci.charge_id = ?
  `).all(charge.id);
  const bookNames = items.map(i => i.quantity > 1 ? `${i.name} x${i.quantity}` : i.name).join(', ');

  const matched = db.prepare(`
    SELECT COALESCE(SUM(matched_amount),0) as sum FROM charge_payment_match WHERE charge_id = ?
  `).get(charge.id).sum;
  const remaining = charge.total_amount - matched;

  const template = getDefaultTemplate('overdue_notice');
  const message = renderTemplate(template.content, {
    studentName: charge.student_name,
    bookNames,
    amount: remaining,
    account: getAccountInfo(),
    dueDate: charge.due_date,
  });
  return { message, remaining };
}

// ---------- 목록 ----------
router.get('/overdue', requireAuth, (req, res) => {
  const convertedCount = detectOverdue();

  const { keyword = '' } = req.query;
  const conditions = ["c.status = 'overdue'"];
  const params = {};
  if (keyword) {
    conditions.push('s.name LIKE @kw');
    params.kw = `%${keyword}%`;
  }
  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const overdueCharges = db.prepare(`
    SELECT c.id, c.total_amount, c.due_date, c.status,
      s.id as student_id, s.name as student_name, s.school_name, s.grade, s.parent_phone,
      CAST(julianday('now') - julianday(c.due_date) AS INTEGER) as overdue_days,
      (SELECT COALESCE(SUM(matched_amount),0) FROM charge_payment_match WHERE charge_id = c.id) as matched_amount,
      (SELECT MAX(sent_at) FROM sms_log WHERE charge_id = c.id AND template_type='overdue_notice') as last_overdue_sms_at
    FROM charge c
    JOIN student s ON s.id = c.student_id
    ${whereClause}
    ORDER BY overdue_days DESC
  `).all(params);

  const totalOverdueAmount = overdueCharges.reduce((sum, c) => sum + (c.total_amount - c.matched_amount), 0);
  const uniqueStudents = new Set(overdueCharges.map(c => c.student_id)).size;

  res.render('overdue/index', {
    pageTitle: '미납 관리',
    active: 'overdue',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    overdueCharges,
    totalOverdueAmount,
    uniqueStudents,
    convertedCount,
    filters: { keyword },
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

// ---------- 개별 발송 ----------
router.post('/overdue/:id/send', requireAuth, (req, res) => {
  const charge = db.prepare(`
    SELECT c.*, s.name as student_name, s.parent_phone, s.id as student_id
    FROM charge c JOIN student s ON s.id = c.student_id WHERE c.id = ?
  `).get(req.params.id);

  if (!charge) {
    return res.redirect('/overdue?flash=' + encodeURIComponent('청구를 찾을 수 없습니다.') + '&flashType=error');
  }

  const { message } = buildOverdueMessage(charge);

  sendSms({
    chargeId: charge.id,
    studentId: charge.student_id,
    templateType: 'overdue_notice',
    recipientPhone: charge.parent_phone,
    messageContent: message,
    sentBy: req.session.adminId,
  });

  res.redirect('/overdue?flash=' + encodeURIComponent(`${charge.student_name} 학생에게 미납 안내를 발송했습니다.`));
});

// ---------- 다중 선택 발송 ----------
router.post('/overdue/send-bulk', requireAuth, (req, res) => {
  const { charge_ids } = req.body;
  const ids = Array.isArray(charge_ids) ? charge_ids : (charge_ids ? [charge_ids] : []);

  if (ids.length === 0) {
    return res.redirect('/overdue?flash=' + encodeURIComponent('발송할 항목을 선택해주세요.') + '&flashType=error');
  }

  let successCount = 0;

  for (const id of ids) {
    const charge = db.prepare(`
      SELECT c.*, s.name as student_name, s.parent_phone, s.id as student_id
      FROM charge c JOIN student s ON s.id = c.student_id WHERE c.id = ? AND c.status='overdue'
    `).get(id);

    if (!charge) continue;

    const { message } = buildOverdueMessage(charge);

    sendSms({
      chargeId: charge.id,
      studentId: charge.student_id,
      templateType: 'overdue_notice',
      recipientPhone: charge.parent_phone,
      messageContent: message,
      sentBy: req.session.adminId,
    });
    successCount++;
  }

  res.redirect('/overdue?flash=' + encodeURIComponent(`${successCount}건의 미납 안내를 발송했습니다.`));
});

module.exports = router;
