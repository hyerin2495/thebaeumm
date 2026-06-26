const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const monthEnd = dayjs().endOf('month').format('YYYY-MM-DD HH:mm:ss');

  const monthlyChargeStats = await db.get(`
    SELECT
      COUNT(*) as charge_count,
      COALESCE(SUM(total_amount), 0) as total_billed
    FROM charge
    WHERE created_at >= ? AND created_at <= ?
  `, [monthStart, monthEnd]);

  const monthlyCollected = await db.get(`
    SELECT COALESCE(SUM(cpm.matched_amount), 0) as collected
    FROM charge_payment_match cpm
    WHERE cpm.matched_at >= ? AND cpm.matched_at <= ?
  `, [monthStart, monthEnd]);

  const overdueCount = await db.get(`
    SELECT COUNT(DISTINCT student_id) as cnt FROM charge WHERE status = 'overdue'
  `);

  const overdueAmount = await db.get(`
    SELECT COALESCE(SUM(total_amount), 0) as amt FROM charge WHERE status = 'overdue'
  `);

  const studentCount = await db.get(`SELECT COUNT(*) as cnt FROM student WHERE status='active'`);
  const bookCount = await db.get(`SELECT COUNT(*) as cnt FROM book WHERE status='active'`);

  const unmatchedTxnCount = await db.get(`SELECT COUNT(*) as cnt FROM payment_txn WHERE match_status='unmatched'`);

  const recentSms = await db.all(`
    SELECT sl.*, s.name as student_name
    FROM sms_log sl
    JOIN student s ON s.id = sl.student_id
    ORDER BY sl.sent_at DESC
    LIMIT 8
  `);

  const recentCharges = await db.all(`
    SELECT c.*, s.name as student_name, s.school_name
    FROM charge c
    JOIN student s ON s.id = c.student_id
    ORDER BY c.created_at DESC
    LIMIT 8
  `);

  res.render('dashboard', {
    pageTitle: '대시보드',
    active: 'dashboard',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    stats: {
      chargeCount: monthlyChargeStats.charge_count,
      totalBilled: monthlyChargeStats.total_billed,
      collected: monthlyCollected.collected,
      overdueCount: overdueCount.cnt,
      overdueAmount: overdueAmount.amt,
      studentCount: studentCount.cnt,
      bookCount: bookCount.cnt,
      unmatchedTxnCount: unmatchedTxnCount.cnt,
    },
    recentSms,
    recentCharges,
    dayjs,
  });
});

module.exports = router;
