const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { renderTemplate, sendSms, getDefaultTemplate, getAccountInfo } = require('../services/sms');
const { detectOverdue } = require('../services/overdueBatch');

const router = express.Router();

async function buildOverdueMessage(charge) {
  const items = await db.all(`
    SELECT ci.quantity, bk.name FROM charge_item ci JOIN book bk ON bk.id = ci.book_id WHERE ci.charge_id = ?
  `, [charge.id]);
  const bookNames = items.map(i => i.quantity > 1 ? `${i.name} x${i.quantity}` : i.name).join(', ');

  const matchedRow = await db.get(`
    SELECT COALESCE(SUM(matched_amount),0) as sum FROM charge_payment_match WHERE charge_id = ?
  `, [charge.id]);
  const remaining = charge.total_amount - matchedRow.sum;

  const template = await getDefaultTemplate('overdue_notice');
  const account = await getAccountInfo();
  const message = renderTemplate(template.content, {
    studentName: charge.student_name,
    bookNames,
    amount: remaining,
    account,
    dueDate: charge.due_date,
  });
  return { message, remaining };
}

router.get('/overdue', requireAuth, async (req, res) => {
  const convertedCount = await detectOverdue();

  const { keyword = '' } = req.query;
  const conditions = ["c.status = 'overdue'"];
  const params = [];
  if (keyword) {
    conditions.push('s.name LIKE ?');
    params.push(`%${keyword}%`);
  }
  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const overdueCharges = await db.all(`
    SELECT c.id, c.total_amount, c.due_date, c.status,
      s.id as student_id, s.name as student_name, s.school_name, s.grade, s.parent_phone,
      DATEDIFF(NOW(), c.due_date) as overdue_days,
      (SELECT COALESCE(SUM(matched_amount),0) FROM charge_payment_match WHERE charge_id = c.id) as matched_amount,
      (SELECT MAX(sent_at) FROM sms_log WHERE charge_id = c.id AND template_type='overdue_notice') as last_overdue_sms_at
    FROM charge c
    JOIN student s ON s.id = c.student_id
    ${whereClause}
    ORDER BY overdue_days DESC
  `, params);

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

router.post('/overdue/:id/send', requireAuth, async (req, res) => {
  const charge = await db.get(`
    SELECT c.*, s.name as student_name, s.parent_phone, s.id as student_id
    FROM charge c JOIN student s ON s.id = c.student_id WHERE c.id = ?
  `, [req.params.id]);

  if (!charge) {
    return res.redirect('/overdue?flash=' + encodeURIComponent('청구를 찾을 수 없습니다.') + '&flashType=error');
  }

  const { message } = await buildOverdueMessage(charge);

  await sendSms({
    chargeId: charge.id,
    studentId: charge.student_id,
    templateType: 'overdue_notice',
    recipientPhone: charge.parent_phone,
    messageContent: message,
    sentBy: req.session.adminId,
  });

  res.redirect('/overdue?flash=' + encodeURIComponent(`${charge.student_name} 학생에게 미납 안내를 발송했습니다.`));
});

router.post('/overdue/send-bulk', requireAuth, async (req, res) => {
  const { charge_ids } = req.body;
  const ids = Array.isArray(charge_ids) ? charge_ids : (charge_ids ? [charge_ids] : []);

  if (ids.length === 0) {
    return res.redirect('/overdue?flash=' + encodeURIComponent('발송할 항목을 선택해주세요.') + '&flashType=error');
  }

  let successCount = 0;

  for (const id of ids) {
    const charge = await db.get(`
      SELECT c.*, s.name as student_name, s.parent_phone, s.id as student_id
      FROM charge c JOIN student s ON s.id = c.student_id WHERE c.id = ? AND c.status='overdue'
    `, [id]);

    if (!charge) continue;

    const { message } = await buildOverdueMessage(charge);

    await sendSms({
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
