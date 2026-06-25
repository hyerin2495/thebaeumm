const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parseUploadedFile, extractTransactions, saveAndAutoMatch, findAutoMatchCandidate } = require('../services/payment');

const router = express.Router();
const PAGE_SIZE = 20;

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error('지원하지 않는 파일 형식입니다.'));
  },
});

// 업로드 후 파싱된 원본 행을 잠깐 들고 있을 메모리 캐시 (세션별, 데모용 — 단일 프로세스 가정)
const pendingUploads = new Map();

// ---------- 목록 ----------
router.get('/payments', requireAuth, (req, res) => {
  const { status = '', keyword = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);

  const conditions = [];
  const params = {};
  if (status && status !== 'all') {
    conditions.push('match_status = @status');
    params.status = status;
  }
  if (keyword) {
    conditions.push('depositor_name LIKE @kw');
    params.kw = `%${keyword}%`;
  }
  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM payment_txn ${whereClause}`).get(params);
  const total = totalRow.cnt;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const txns = db.prepare(`
    SELECT * FROM payment_txn ${whereClause}
    ORDER BY txn_datetime DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: PAGE_SIZE, offset });

  const unmatchedCount = db.prepare(`SELECT COUNT(*) as cnt FROM payment_txn WHERE match_status='unmatched'`).get();

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

// ---------- 업로드 폼 ----------
router.get('/payments/upload', requireAuth, (req, res) => {
  res.render('payments/upload', {
    pageTitle: '거래내역 업로드',
    active: 'payments',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    flash: null,
  });
});

// ---------- 업로드 처리 → 컬럼 매핑 화면으로 ----------
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
    fs.unlinkSync(req.file.path); // 파싱 끝났으니 임시파일 삭제

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

    // 5분 후 캐시 정리 (메모리 누수 방지)
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

// ---------- 매핑 확정 → 미리보기 ----------
router.post('/payments/mapping', requireAuth, (req, res) => {
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

  // 다음 단계(확정 저장)에서 쓸 수 있게 결과도 캐시에 저장
  pending.mapping = mapping;
  pending.hasHeader = hasHeader;
  pending.extracted = results;
  pending.errors = errors;

  // 미리보기용: dedupe 여부 + 자동매칭 예상 결과 미리 체크
  const previewWithDup = results.slice(0, 50).map(t => {
    const dedupeKey = `${t.txnDatetime}_${t.amount}_${t.depositorName}`;
    const exists = db.prepare('SELECT id FROM payment_txn WHERE dedupe_key = ?').get(dedupeKey);
    const candidate = exists ? null : findAutoMatchCandidate(t.depositorName, t.amount);
    return { ...t, isDuplicate: !!exists, willAutoMatch: !!candidate };
  });

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

// ---------- 최종 저장 + 자동매칭 ----------
router.post('/payments/confirm', requireAuth, (req, res) => {
  const { uploadId } = req.body;
  const pending = pendingUploads.get(uploadId);

  if (!pending || !pending.extracted) {
    return res.redirect('/payments/upload?flash=' + encodeURIComponent('업로드 세션이 만료되었습니다. 다시 업로드해주세요.') + '&flashType=error');
  }

  const result = saveAndAutoMatch(pending.extracted, pending.originalName, req.session.adminId);
  pendingUploads.delete(uploadId);

  const message = `${result.inserted}건 저장 (중복 제외 ${result.duplicated}건) · 자동매칭 ${result.autoMatched}건`;
  res.redirect('/payments?flash=' + encodeURIComponent(message));
});

// ---------- 수동 매칭 화면 (미확인 입금 1건 선택해서 청구 연결) ----------
router.get('/payments/:id/match', requireAuth, (req, res) => {
  const txn = db.prepare('SELECT * FROM payment_txn WHERE id = ?').get(req.params.id);
  if (!txn) return res.redirect('/payments?flash=' + encodeURIComponent('거래를 찾을 수 없습니다.') + '&flashType=error');

  const depositorText = txn.depositor_name.replace(/\s+/g, '');

  // 후보 추천 우선순위: ① 학부모전화 뒷4자리 포함 ② 학생이름 포함 ③ 학부모이름 포함 ④ 금액일치
  // (입금자 텍스트가 보통 "학생이름+학교+학년" 형식이므로, "텍스트 안에 이름/번호가 포함되는지"로 검사한다 — 반대 방향 LIKE는 거의 매칭되지 않음)
  const candidates = db.prepare(`
    SELECT c.id, c.total_amount, c.due_date, c.status, s.name as student_name, s.parent_name, s.school_name,
      (CASE
        WHEN s.parent_phone IS NOT NULL AND instr(@text, substr(s.parent_phone, -4)) > 0 THEN 1
        WHEN length(s.name) >= 2 AND instr(@text, s.name) > 0 THEN 2
        WHEN s.parent_name IS NOT NULL AND length(s.parent_name) >= 2 AND instr(@text, s.parent_name) > 0 THEN 3
        WHEN c.total_amount = @amount THEN 4
        ELSE 9
      END) as match_rank
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE c.status IN ('unpaid', 'overdue', 'partial')
      AND (
        (s.parent_phone IS NOT NULL AND instr(@text, substr(s.parent_phone, -4)) > 0)
        OR (length(s.name) >= 2 AND instr(@text, s.name) > 0)
        OR (s.parent_name IS NOT NULL AND length(s.parent_name) >= 2 AND instr(@text, s.parent_name) > 0)
        OR c.total_amount = @amount
      )
    ORDER BY match_rank ASC, c.due_date ASC
    LIMIT 20
  `).all({ text: depositorText, amount: txn.amount });

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

// ---------- 수동 매칭 처리 ----------
router.post('/payments/:id/match', requireAuth, (req, res) => {
  const { charge_id, matched_amount } = req.body;
  const txnId = req.params.id;

  const txn = db.prepare('SELECT * FROM payment_txn WHERE id = ?').get(txnId);
  const charge = db.prepare('SELECT * FROM charge WHERE id = ?').get(charge_id);

  if (!txn || !charge) {
    return res.redirect(`/payments/${txnId}/match?flash=` + encodeURIComponent('처리 중 오류가 발생했습니다.') + '&flashType=error');
  }

  const amount = parseInt(matched_amount, 10) || txn.amount;

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO charge_payment_match (charge_id, payment_txn_id, matched_amount, match_type, matched_by, matched_at)
      VALUES (?, ?, ?, 'manual', ?, datetime('now'))
    `).run(charge.id, txn.id, amount, req.session.adminId);

    db.prepare(`UPDATE payment_txn SET match_status='matched' WHERE id=?`).run(txn.id);

    // 매칭 합계로 청구 상태 갱신
    const totalMatched = db.prepare(`
      SELECT COALESCE(SUM(matched_amount),0) as sum FROM charge_payment_match WHERE charge_id = ?
    `).get(charge.id).sum;

    const newStatus = totalMatched >= charge.total_amount ? 'paid' : 'partial';
    db.prepare(`UPDATE charge SET status=?, updated_at=datetime('now') WHERE id=?`).run(newStatus, charge.id);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.redirect('/payments?flash=' + encodeURIComponent('입금이 매칭 처리되었습니다.'));
});

// ---------- 무시 처리 (잘못 들어온 거래) ----------
router.post('/payments/:id/ignore', requireAuth, (req, res) => {
  db.prepare(`UPDATE payment_txn SET match_status='ignored' WHERE id=?`).run(req.params.id);
  res.redirect('/payments?flash=' + encodeURIComponent('해당 거래를 무시 처리했습니다.'));
});

module.exports = router;
