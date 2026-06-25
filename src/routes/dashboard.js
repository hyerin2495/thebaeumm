const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const monthEnd = dayjs().endOf('month').format('YYYY-MM-DD HH:mm:ss');

  // 이번 달 청구 현황
  const monthlyChargeStats = db.prepare(`
    SELECT
      COUNT(*) as charge_count,
      COALESCE(SUM(total_amount), 0) as total_billed
    FROM charge
    WHERE created_at >= ? AND created_at <= ?
  `).get(monthStart, monthEnd);

  // 이번 달 수납 현황 (charge_payment_match 기준)
  const monthlyCollected = db.prepare(`
    SELECT COALESCE(SUM(cpm.matched_amount), 0) as collected
    FROM charge_payment_match cpm
    WHERE cpm.matched_at >= ? AND cpm.matched_at <= ?
  `).get(monthStart, monthEnd);

  // 미납자 수 (overdue 상태인 청구의 학생 수, 중복제거)
  const overdueCount = db.prepare(`
    SELECT COUNT(DISTINCT student_id) as cnt FROM charge WHERE status = 'overdue'
  `).get();

  const overdueAmount = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as amt FROM charge WHERE status = 'overdue'
  `).get();

  // 전체 학생/교재 수
  const studentCount = db.prepare(`SELECT COUNT(*) as cnt FROM student WHERE status='active'`).get();
  const bookCount = db.prepare(`SELECT COUNT(*) as cnt FROM book WHERE status='active'`).get();

  // 미확인 입금
  const unmatchedTxnCount = db.prepare(`SELECT COUNT(*) as cnt FROM payment_txn WHERE match_status='unmatched'`).get();

  // 최근 SMS 발송 로그 8건
  const recentSms = db.prepare(`
    SELECT sl.*, s.name as student_name
    FROM sms_log sl
    JOIN student s ON s.id = sl.student_id
    ORDER BY sl.sent_at DESC
    LIMIT 8
  `).all();

  // 최근 청구 8건
  const recentCharges = db.prepare(`
    SELECT c.*, s.name as student_name, s.school_name
    FROM charge c
    JOIN student s ON s.id = c.student_id
    ORDER BY c.created_at DESC
    LIMIT 8
  `).all();

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
