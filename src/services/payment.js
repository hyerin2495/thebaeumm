const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');
const dayjs = require('dayjs');
const db = require('../db');

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
      const values = row.values.slice(1);
      rows.push(values.map(v => {
        if (v == null) return '';
        if (typeof v === 'object' && v.text) return v.text;
        if (typeof v === 'object' && v.result != null) return v.result;
        if (v instanceof Date) return dayjs(v).format('YYYY-MM-DD HH:mm:ss');
        return v;
      }));
    });
    return rows;
  }

  throw new Error('지원하지 않는 파일 형식입니다. (.xlsx 또는 .csv만 가능)');
}

function buildDedupeKey(datetime, amount, depositor) {
  return `${datetime}_${amount}_${depositor}`;
}

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

function normalizeAmount(raw) {
  if (raw == null) return null;
  const str = String(raw).replace(/[,원\s]/g, '');
  const num = parseInt(str, 10);
  return Number.isFinite(num) ? num : null;
}

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

// MySQL: LOCATE(needle, haystack) — SQLite instr(haystack, needle)와 인자 순서 반대
async function findAutoMatchCandidate(depositorText, amount) {
  const text = (depositorText || '').replace(/\s+/g, '');

  const remainingExpr = `(c.total_amount - COALESCE((SELECT SUM(matched_amount) FROM charge_payment_match WHERE charge_id = c.id), 0))`;

  const byParentPhone = await db.get(`
    SELECT c.id, c.total_amount, s.id as student_id
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE ${remainingExpr} = ?
      AND c.status IN ('unpaid', 'overdue', 'partial')
      AND s.parent_phone IS NOT NULL
      AND LOCATE(RIGHT(s.parent_phone, 4), ?) > 0
    ORDER BY c.due_date ASC
    LIMIT 1
  `, [amount, text]);
  if (byParentPhone) return { ...byParentPhone, matchedBy: 'parent_phone' };

  const byStudentName = await db.get(`
    SELECT c.id, c.total_amount, s.id as student_id
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE ${remainingExpr} = ?
      AND c.status IN ('unpaid', 'overdue', 'partial')
      AND LENGTH(s.name) >= 2
      AND LOCATE(s.name, ?) > 0
    ORDER BY c.due_date ASC
    LIMIT 1
  `, [amount, text]);
  if (byStudentName) return { ...byStudentName, matchedBy: 'student_name' };

  const byParentName = await db.get(`
    SELECT c.id, c.total_amount, s.id as student_id
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE ${remainingExpr} = ?
      AND c.status IN ('unpaid', 'overdue', 'partial')
      AND s.parent_name IS NOT NULL
      AND LENGTH(s.parent_name) >= 2
      AND LOCATE(s.parent_name, ?) > 0
    ORDER BY c.due_date ASC
    LIMIT 1
  `, [amount, text]);
  if (byParentName) return { ...byParentName, matchedBy: 'parent_name' };

  return null;
}

async function saveAndAutoMatch(transactions, sourceFile, uploadedBy) {
  let inserted = 0;
  let duplicated = 0;
  let autoMatched = 0;

  for (const t of transactions) {
    const dedupeKey = buildDedupeKey(t.txnDatetime, t.amount, t.depositorName);
    const existing = await db.get('SELECT id FROM payment_txn WHERE dedupe_key = ?', [dedupeKey]);

    if (existing) {
      duplicated++;
      continue;
    }

    try {
      await db.transaction(async (conn) => {
        const txnResult = await conn.run(
          `INSERT INTO payment_txn (txn_datetime, depositor_name, amount, memo, source_file, dedupe_key, match_status, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'unmatched', ?, NOW())`,
          [t.txnDatetime, t.depositorName, t.amount, t.memo, sourceFile, dedupeKey, uploadedBy]
        );
        const txnId = txnResult.insertId;
        inserted++;

        const candidate = await findAutoMatchCandidate(t.depositorName, t.amount);
        if (candidate) {
          const alreadyMatchedRow = await conn.get(
            'SELECT COALESCE(SUM(matched_amount),0) as sum FROM charge_payment_match WHERE charge_id = ?',
            [candidate.id]
          );
          const alreadyMatched = alreadyMatchedRow.sum;

          await conn.run(
            `INSERT INTO charge_payment_match (charge_id, payment_txn_id, matched_amount, match_type, matched_by, matched_at)
             VALUES (?, ?, ?, 'auto', ?, NOW())`,
            [candidate.id, txnId, t.amount, uploadedBy]
          );
          await conn.run('UPDATE payment_txn SET match_status = ? WHERE id = ?', ['matched', txnId]);

          const newTotal = alreadyMatched + t.amount;
          const newStatus = newTotal >= candidate.total_amount ? 'paid' : 'partial';
          await conn.run('UPDATE charge SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, candidate.id]);
          autoMatched++;
        }
      });
    } catch (err) {
      console.error('saveAndAutoMatch 트랜잭션 오류:', err);
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
