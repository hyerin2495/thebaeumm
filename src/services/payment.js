const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');
const dayjs = require('dayjs');
const db = require('../db');

/**
 * 업로드된 파일(xlsx/csv)을 파싱해서 2차원 배열(행렬)로 반환.
 * 첫 행은 헤더로 간주.
 */
async function parseUploadedFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.csv') {
    const content = fs.readFileSync(filePath, 'utf-8');
    const records = parseCsv(content, { skip_empty_lines: true });
    return records;
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const rows = [];
    sheet.eachRow((row) => {
      const values = row.values.slice(1); // exceljs는 1-indexed, 0번째는 빈값
      rows.push(values.map(v => {
        if (v == null) return '';
        if (typeof v === 'object' && v.text) return v.text; // richtext
        if (typeof v === 'object' && v.result != null) return v.result; // formula
        if (v instanceof Date) return dayjs(v).format('YYYY-MM-DD HH:mm:ss');
        return v;
      }));
    });
    return rows;
  }

  throw new Error('지원하지 않는 파일 형식입니다. (.xlsx 또는 .csv만 가능)');
}

/**
 * dedupe key 생성: 거래일시+금액+입금자명 조합
 */
function buildDedupeKey(datetime, amount, depositor) {
  return `${datetime}_${amount}_${depositor}`;
}

/**
 * 날짜 문자열을 표준 포맷으로 정규화 시도.
 * 다양한 은행 포맷(2026-06-25, 2026.06.25, 26/06/25 등) 대응.
 */
function normalizeDateTime(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const candidates = [
    'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD',
    'YYYY.MM.DD HH:mm:ss', 'YYYY.MM.DD',
    'YYYY/MM/DD HH:mm:ss', 'YYYY/MM/DD',
  ];
  for (const fmt of candidates) {
    const parsed = dayjs(str, fmt, true);
    if (parsed.isValid()) return parsed.format('YYYY-MM-DD HH:mm:ss');
  }
  const loose = dayjs(str);
  if (loose.isValid()) return loose.format('YYYY-MM-DD HH:mm:ss');
  return null;
}

/**
 * 금액 문자열 정규화 (쉼표, 원화기호, 공백 제거)
 */
function normalizeAmount(raw) {
  if (raw == null) return null;
  const str = String(raw).replace(/[,원\s]/g, '');
  const num = parseInt(str, 10);
  return Number.isFinite(num) ? num : null;
}

/**
 * 컬럼 매핑을 사용해 행 데이터를 정규화된 거래 객체 배열로 변환.
 *
 * 실제 은행 거래내역 양식(예: 순번/거래일시/출금금액/입금금액/거래내용/거래기록사항/거래점/거래메모)은
 * "입금자명"이 별도 컬럼으로 존재하지 않고, 출금금액과 입금금액이 분리되어 있다.
 * 따라서:
 *  - 입금자 식별 텍스트는 "거래내용"(또는 거래기록사항 등) 컬럼에서 가져온다.
 *  - 금액은 입금금액 컬럼만 사용하고, 입금금액이 비어있거나 0인 행(=출금 거래)은 제외한다.
 *
 * mapping: { datetime: colIndex, depositor: colIndex, depositAmount: colIndex, withdrawAmount: colIndex|null, memo: colIndex|null }
 * depositAmount/withdrawAmount 중 입금 컬럼만 필수. withdrawAmount는 출금행 식별/제외 용도로만 쓰임(선택).
 */
function extractTransactions(rows, mapping, hasHeader) {
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const results = [];
  const errors = [];
  let skippedWithdrawals = 0;

  dataRows.forEach((row, idx) => {
    const rawDatetime = row[mapping.datetime];
    const rawDepositor = row[mapping.depositor];
    const rawDepositAmount = row[mapping.depositAmount];
    const rawWithdrawAmount = mapping.withdrawAmount != null ? row[mapping.withdrawAmount] : null;
    const rawMemo = mapping.memo != null ? row[mapping.memo] : null;

    const depositAmount = normalizeAmount(rawDepositAmount);
    const withdrawAmount = mapping.withdrawAmount != null ? normalizeAmount(rawWithdrawAmount) : null;

    // 입금금액이 없고 출금금액만 있는 행 = 출금 거래 → 건너뜀 (오류 아님)
    if ((!depositAmount || depositAmount === 0) && withdrawAmount && withdrawAmount > 0) {
      skippedWithdrawals++;
      return;
    }

    const datetime = normalizeDateTime(rawDatetime);
    const depositor = rawDepositor != null ? String(rawDepositor).trim() : '';

    if (!datetime || !depositAmount || depositAmount <= 0 || !depositor) {
      errors.push({ rowIndex: idx + (hasHeader ? 2 : 1), raw: row });
      return;
    }

    results.push({
      txnDatetime: datetime,
      depositorName: depositor,
      amount: depositAmount,
      memo: rawMemo != null ? String(rawMemo).trim() : null,
    });
  });

  return { results, errors, skippedWithdrawals };
}

/**
 * 거래내역 DB 저장 (중복 제외) + 자동 매칭 시도.
 *
 * 자동 매칭 우선순위 (남은 잔액과 정확히 일치해야 함 — 다르면 자동확정하지 않고 미확인으로 둠):
 *   1. 학부모 전화번호 뒷4자리가 입금자 식별텍스트에 포함
 *   2. 학생이름이 입금자 식별텍스트에 포함 (학원 안내 양식이 "학생이름+학교+학년"이라 가장 흔한 패턴)
 *   3. 학부모이름이 입금자 식별텍스트에 포함
 * 위 순서대로 시도해서 가장 먼저 매칭되는 후보 하나를 사용한다.
 * partial 상태 청구는 total_amount가 아니라 "남은 잔액"(total_amount - 기존 매칭 합계)을 기준으로 비교한다.
 */
function findAutoMatchCandidate(depositorText, amount) {
  const text = (depositorText || '').replace(/\s+/g, ''); // 공백 제거 후 포함여부 검사

  const remainingExpr = `(c.total_amount - COALESCE((SELECT SUM(matched_amount) FROM charge_payment_match WHERE charge_id = c.id), 0))`;

  // 1순위: 학부모 전화번호 뒷4자리 포함
  const byParentPhone = db.prepare(`
    SELECT c.id, c.total_amount, s.id as student_id
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE ${remainingExpr} = ?
      AND c.status IN ('unpaid', 'overdue', 'partial')
      AND s.parent_phone IS NOT NULL
      AND instr(?, substr(s.parent_phone, -4)) > 0
    ORDER BY c.due_date ASC
    LIMIT 1
  `).get(amount, text);
  if (byParentPhone) return { ...byParentPhone, matchedBy: 'parent_phone' };

  // 2순위: 학생이름이 입금자 텍스트에 포함 (이름 2자 미만은 오매칭 위험이 커서 제외)
  const byStudentName = db.prepare(`
    SELECT c.id, c.total_amount, s.id as student_id
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE ${remainingExpr} = ?
      AND c.status IN ('unpaid', 'overdue', 'partial')
      AND length(s.name) >= 2
      AND instr(?, s.name) > 0
    ORDER BY c.due_date ASC
    LIMIT 1
  `).get(amount, text);
  if (byStudentName) return { ...byStudentName, matchedBy: 'student_name' };

  // 3순위: 학부모이름이 입금자 텍스트에 포함
  const byParentName = db.prepare(`
    SELECT c.id, c.total_amount, s.id as student_id
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE ${remainingExpr} = ?
      AND c.status IN ('unpaid', 'overdue', 'partial')
      AND s.parent_name IS NOT NULL
      AND length(s.parent_name) >= 2
      AND instr(?, s.parent_name) > 0
    ORDER BY c.due_date ASC
    LIMIT 1
  `).get(amount, text);
  if (byParentName) return { ...byParentName, matchedBy: 'parent_name' };

  return null;
}

function saveAndAutoMatch(transactions, sourceFile, uploadedBy) {
  const insertTxn = db.prepare(`
    INSERT INTO payment_txn (txn_datetime, depositor_name, amount, memo, source_file, dedupe_key, match_status, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'unmatched', ?, datetime('now'))
  `);
  const insertMatch = db.prepare(`
    INSERT INTO charge_payment_match (charge_id, payment_txn_id, matched_amount, match_type, matched_by, matched_at)
    VALUES (?, ?, ?, 'auto', ?, datetime('now'))
  `);
  const updateTxnStatus = db.prepare(`UPDATE payment_txn SET match_status = ? WHERE id = ?`);
  const updateChargeStatus = db.prepare(`
    UPDATE charge SET status = ?, updated_at = datetime('now') WHERE id = ?
  `);

  let inserted = 0;
  let duplicated = 0;
  let autoMatched = 0;

  for (const t of transactions) {
    const dedupeKey = buildDedupeKey(t.txnDatetime, t.amount, t.depositorName);
    const existing = db.prepare('SELECT id FROM payment_txn WHERE dedupe_key = ?').get(dedupeKey);

    if (existing) {
      duplicated++;
      continue;
    }

    db.exec('BEGIN');
    try {
      const txnResult = insertTxn.run(t.txnDatetime, t.depositorName, t.amount, t.memo, sourceFile, dedupeKey, uploadedBy);
      const txnId = txnResult.lastInsertRowid;
      inserted++;

      const candidate = findAutoMatchCandidate(t.depositorName, t.amount);
      if (candidate) {
        // 이미 일부 매칭된(partial) 청구일 수 있으므로, 이번 매칭으로 합계가 총액에 도달하는지 확인
        const alreadyMatched = db.prepare(`
          SELECT COALESCE(SUM(matched_amount),0) as sum FROM charge_payment_match WHERE charge_id = ?
        `).get(candidate.id).sum;

        insertMatch.run(candidate.id, txnId, t.amount, uploadedBy);
        updateTxnStatus.run('matched', txnId);

        const newTotal = alreadyMatched + t.amount;
        const newStatus = newTotal >= candidate.total_amount ? 'paid' : 'partial';
        updateChargeStatus.run(newStatus, candidate.id);
        autoMatched++;
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return { inserted, duplicated, autoMatched, total: transactions.length };
}

module.exports = {
  parseUploadedFile,
  extractTransactions,
  saveAndAutoMatch,
  findAutoMatchCandidate,
  buildDedupeKey,
  normalizeDateTime,
  normalizeAmount,
};
