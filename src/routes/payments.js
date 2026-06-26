const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parseUploadedFile, extractTransactions, saveAndAutoMatch, findAutoMatchCandidate } = require('../services/payment');

const router = express.Router();
const PAGE_SIZE = 20;

const UPLOAD_DIR = os.tmpdir();

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error('지원하지 않는 파일 형식입니다.'));
  },
});

const pendingUploads = new Map();

router.get('/payments', requireAuth, async (req, res) => {
  const { status = '', keyword = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);

  const conditions = [];
  const params = [];
  if (status && status !== 'all') {
    conditions.push('match_status = ?');
    params.push(status);
  }
  if (keyword) {
    conditions.push('depositor_name LIKE ?');
    params.push(`%${keyword}%`);
  }
  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = await db.get(`SELECT COUNT(*) as cnt FROM payment_txn ${whereClause}`, params);
  const total = totalRow.cnt;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const txns = await db.all(`
    SELECT * FROM payment_txn ${whereClause}
    ORDER BY txn_datetime DESC
    LIMIT ? OFFSET ?
  `, [...params, PAGE_SIZE, offset]);

  const unmatchedCount = await db.get(`SELECT COUNT(*) as cnt FROM payment_txn WHERE match_status='unmatched'`);

  res.render('payments/index', {
    pageTitle: '입금 관리',
    active: 'payments',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    txns,
    filters: { status, keyword },
    pagination: { page: safePage, totalPages, total },
    unmatchedCount: unmatchedCount.cnt,
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

router.get('/payments/upload', requireAuth, (req, res) => {
  res.render('payments/upload', {
    pageTitle: '거래내역 업로드',
    active: 'payments',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    flash: null,
  });
});

router.post('/payments/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.render('payments/upload', {
      pageTitle: '거래내역 업로드',
      active: 'payments',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      flash: { type: 'error', message: '파일을 선택해주세요.' },
    });
  }

  try {
    const rows = await parseUploadedFile(req.file.path, req.file.originalname);
    fs.unlinkSync(req.file.path);

    if (rows.length === 0) {
      return res.render('payments/upload', {
        pageTitle: '거래내역 업로드',
        active: 'payments',
        adminName: req.session.adminName,
        adminRole: req.session.adminRole,
        flash: { type: 'error', message: '파일에 데이터가 없습니다.' },
      });
    }

    const uploadId = `upload_${Date.now()}`;
    pendingUploads.set(uploadId, { rows, originalName: req.file.originalname });
    setTimeout(() => pendingUploads.delete(uploadId), 5 * 60 * 1000);

    res.render('payments/mapping', {
      pageTitle: '컬럼 매핑',
      active: 'payments',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      uploadId,
      originalName: req.file.originalname,
      headerRow: rows[0],
      previewRows: rows.slice(1, 4),
      totalRows: rows.length - 1,
      flash: null,
    });
  } catch (err) {
    res.render('payments/upload', {
      pageTitle: '거래내역 업로드',
      active: 'payments',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      flash: { type: 'error', message: '파일 처리 중 오류: ' + err.message },
    });
  }
});

router.post('/payments/mapping', requireAuth, async (req, res) => {
  const { uploadId, col_datetime, col_depositor, col_deposit_amount, col_withdraw_amount, col_memo, has_header } = req.body;

  const pending = pendingUploads.get(uploadId);
  if (!pending) {
    return res.redirect('/payments/upload?flash=' + encodeURIComponent('업로드 세션이 만료되었습니다. 다시 업로드해주세요.') + '&flashType=error');
  }

  const mapping = {
    datetime: parseInt(col_datetime, 10),
    depositor: parseInt(col_depositor, 10),
    depositAmount: parseInt(col_deposit_amount, 10),
    withdrawAmount: col_withdraw_amount !== '' && col_withdraw_amount != null ? parseInt(col_withdraw_amount, 10) : null,
    memo: col_memo !== '' && col_memo != null ? parseInt(col_memo, 10) : null,
  };
  const hasHeader = has_header === 'on' || has_header === 'true';

  const { results, errors, skippedWithdrawals } = extractTransactions(pending.rows, mapping, hasHeader);

  pending.mapping = mapping;
  pending.hasHeader = hasHeader;
  pending.extracted = results;
  pending.errors = errors;

  const previewWithDup = await Promise.all(results.slice(0, 50).map(async (t) => {
    const dedupeKey = `${t.txnDatetime}_${t.amount}_${t.depositorName}`;
    const exists = await db.get('SELECT id FROM payment_txn WHERE dedupe_key = ?', [dedupeKey]);
    const candidate = exists ? null : await findAutoMatchCandidate(t.depositorName, t.amount);
    return { ...t, isDuplicate: !!exists, willAutoMatch: !!candidate };
  }));

  res.render('payments/preview', {
    pageTitle: '업로드 확인',
    active: 'payments',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    uploadId,
    originalName: pending.originalName,
    previewWithDup,
    totalCount: results.length,
    errorCount: errors.length,
    skippedWithdrawals,
    errors: errors.slice(0, 10),
    flash: null,
  });
});

router.post('/payments/confirm', requireAuth, async (req, res) => {
  const { uploadId } = req.body;
  const pending = pendingUploads.get(uploadId);

  if (!pending || !pending.extracted) {
    return res.redirect('/payments/upload?flash=' + encodeURIComponent('업로드 세션이 만료되었습니다. 다시 업로드해주세요.') + '&flashType=error');
  }

  const result = await saveAndAutoMatch(pending.extracted, pending.originalName, req.session.adminId);
  pendingUploads.delete(uploadId);

  const message = `${result.inserted}건 저장 (중복 제외 ${result.duplicated}건) · 자동매칭 ${result.autoMatched}건`;
  res.redirect('/payments?flash=' + encodeURIComponent(message));
});

router.get('/payments/:id/match', requireAuth, async (req, res) => {
  const txn = await db.get('SELECT * FROM payment_txn WHERE id = ?', [req.params.id]);
  if (!txn) return res.redirect('/payments?flash=' + encodeURIComponent('거래를 찾을 수 없습니다.') + '&flashType=error');

  const depositorText = txn.depositor_name.replace(/\s+/g, '');

  // MySQL: LOCATE(needle, haystack) — SQLite instr(haystack, needle)와 인자 순서 반대
  const candidates = await db.all(`
    SELECT c.id, c.total_amount, c.due_date, c.status, s.name as student_name, s.parent_name, s.school_name,
      (CASE
        WHEN s.parent_phone IS NOT NULL AND LOCATE(RIGHT(s.parent_phone, 4), ?) > 0 THEN 1
        WHEN LENGTH(s.name) >= 2 AND LOCATE(s.name, ?) > 0 THEN 2
        WHEN s.parent_name IS NOT NULL AND LENGTH(s.parent_name) >= 2 AND LOCATE(s.parent_name, ?) > 0 THEN 3
        WHEN c.total_amount = ? THEN 4
        ELSE 9
      END) as match_rank
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE c.status IN ('unpaid', 'overdue', 'partial')
      AND (
        (s.parent_phone IS NOT NULL AND LOCATE(RIGHT(s.parent_phone, 4), ?) > 0)
        OR (LENGTH(s.name) >= 2 AND LOCATE(s.name, ?) > 0)
        OR (s.parent_name IS NOT NULL AND LENGTH(s.parent_name) >= 2 AND LOCATE(s.parent_name, ?) > 0)
        OR c.total_amount = ?
      )
    ORDER BY match_rank ASC, c.due_date ASC
    LIMIT 20
  `, [depositorText, depositorText, depositorText, txn.amount, depositorText, depositorText, depositorText, txn.amount]);

  res.render('payments/match', {
    pageTitle: '입금 매칭',
    active: 'payments',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    txn,
    candidates,
    matchRankLabel: { 1: '전화번호 일치', 2: '학생이름 포함', 3: '학부모이름 포함', 4: '금액 일치', 9: '' },
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

router.post('/payments/:id/match', requireAuth, async (req, res) => {
  const { charge_id, matched_amount } = req.body;
  const txnId = req.params.id;

  const txn = await db.get('SELECT * FROM payment_txn WHERE id = ?', [txnId]);
  const charge = await db.get('SELECT * FROM charge WHERE id = ?', [charge_id]);

  if (!txn || !charge) {
    return res.redirect(`/payments/${txnId}/match?flash=` + encodeURIComponent('처리 중 오류가 발생했습니다.') + '&flashType=error');
  }

  const amount = parseInt(matched_amount, 10) || txn.amount;

  await db.transaction(async (conn) => {
    await conn.run(
      `INSERT INTO charge_payment_match (charge_id, payment_txn_id, matched_amount, match_type, matched_by, matched_at) VALUES (?, ?, ?, 'manual', ?, NOW())`,
      [charge.id, txn.id, amount, req.session.adminId]
    );
    await conn.run(`UPDATE payment_txn SET match_status='matched' WHERE id=?`, [txn.id]);

    const totalMatchedRow = await conn.get(
      'SELECT COALESCE(SUM(matched_amount),0) as sum FROM charge_payment_match WHERE charge_id = ?',
      [charge.id]
    );
    const newStatus = totalMatchedRow.sum >= charge.total_amount ? 'paid' : 'partial';
    await conn.run('UPDATE charge SET status=?, updated_at=NOW() WHERE id=?', [newStatus, charge.id]);
  });

  res.redirect('/payments?flash=' + encodeURIComponent('입금이 매칭 처리되었습니다.'));
});

router.post('/payments/:id/ignore', requireAuth, async (req, res) => {
  await db.run(`UPDATE payment_txn SET match_status='ignored' WHERE id=?`, [req.params.id]);
  res.redirect('/payments?flash=' + encodeURIComponent('해당 거래를 무시 처리했습니다.'));
});

module.exports = router;
