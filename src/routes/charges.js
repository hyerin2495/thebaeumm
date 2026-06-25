const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { renderTemplate, sendSms, getDefaultTemplate, getAccountInfo } = require('../services/sms');

const router = express.Router();
const PAGE_SIZE = 15;

const STATUS_LABEL = { paid: '완납', unpaid: '미수금', overdue: '미납', partial: '부분납', canceled: '취소' };

// ---------- 목록 ----------
router.get('/charges', requireAuth, (req, res) => {
  const { keyword = '', status = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);

  const conditions = [];
  const params = {};

  if (keyword) {
    conditions.push('s.name LIKE @kw');
    params.kw = `%${keyword}%`;
  }
  if (status) {
    conditions.push('c.status = @status');
    params.status = status;
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM charge c JOIN student s ON s.id = c.student_id ${whereClause}
  `).get(params);
  const total = totalRow.cnt;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const charges = db.prepare(`
    SELECT c.*, s.name as student_name, s.school_name, s.grade,
      (SELECT GROUP_CONCAT(bk.name, ', ') FROM charge_item ci JOIN book bk ON bk.id = ci.book_id WHERE ci.charge_id = c.id) as book_names,
      (SELECT COUNT(*) FROM charge_item ci WHERE ci.charge_id = c.id) as item_count
    FROM charge c
    JOIN student s ON s.id = c.student_id
    ${whereClause}
    ORDER BY c.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: PAGE_SIZE, offset });

  res.render('charges/index', {
    pageTitle: '청구 관리',
    active: 'charges',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    charges,
    statusLabel: STATUS_LABEL,
    filters: { keyword, status },
    pagination: { page: safePage, totalPages, total },
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

// ---------- 생성 폼 ----------
router.get('/charges/new', requireAuth, (req, res) => {
  const students = db.prepare(`SELECT id, name, school_name, grade, parent_phone FROM student WHERE status='active' ORDER BY name`).all();
  const books = db.prepare(`SELECT id, name, subject, price FROM book WHERE status='active' ORDER BY subject, name`).all();

  res.render('charges/form', {
    pageTitle: '청구 등록',
    active: 'charges',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    students,
    books,
    defaultDueDate: dayjs().add(7, 'day').format('YYYY-MM-DD'),
    flash: null,
  });
});

// ---------- 생성 처리 ----------
router.post('/charges/new', requireAuth, (req, res) => {
  const { student_id, due_date, book_id, quantity, send_sms } = req.body;

  const students = db.prepare(`SELECT id, name, school_name, grade, parent_phone FROM student WHERE status='active' ORDER BY name`).all();
  const books = db.prepare(`SELECT id, name, subject, price FROM book WHERE status='active' ORDER BY subject, name`).all();

  // book_id, quantity는 체크된 항목만 배열(또는 단일값)로 들어옴
  const bookIds = Array.isArray(book_id) ? book_id : (book_id ? [book_id] : []);
  const quantities = Array.isArray(quantity) ? quantity : (quantity ? [quantity] : []);

  if (!student_id || bookIds.length === 0 || !due_date) {
    return res.render('charges/form', {
      pageTitle: '청구 등록',
      active: 'charges',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      students,
      books,
      defaultDueDate: due_date || dayjs().add(7, 'day').format('YYYY-MM-DD'),
      flash: { type: 'error', message: '학생, 교재(1개 이상), 입금기한은 필수입니다.' },
    });
  }

  const student = db.prepare('SELECT * FROM student WHERE id = ?').get(student_id);
  if (!student) {
    return res.redirect('/charges/new?flash=' + encodeURIComponent('학생 정보를 찾을 수 없습니다.') + '&flashType=error');
  }

  // 트랜잭션: 청구 + 청구상세 생성
  const insertCharge = db.prepare(`
    INSERT INTO charge (student_id, total_amount, due_date, status, created_by, created_at, updated_at)
    VALUES (?, 0, ?, 'unpaid', ?, datetime('now'), datetime('now'))
  `);
  const insertItem = db.prepare(`
    INSERT INTO charge_item (charge_id, book_id, quantity, unit_price, line_amount)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateTotal = db.prepare(`UPDATE charge SET total_amount = ? WHERE id = ?`);

  let chargeId, totalAmount, bookNamesUsed;

  db.exec('BEGIN');
  try {
    const chargeResult = insertCharge.run(student_id, due_date, req.session.adminId);
    chargeId = chargeResult.lastInsertRowid;

    totalAmount = 0;
    bookNamesUsed = [];

    for (let i = 0; i < bookIds.length; i++) {
      const book = db.prepare('SELECT * FROM book WHERE id = ?').get(bookIds[i]);
      if (!book) continue;
      const qty = Math.max(1, parseInt(quantities[i], 10) || 1);
      const lineAmount = book.price * qty;
      totalAmount += lineAmount;
      bookNamesUsed.push(qty > 1 ? `${book.name} x${qty}` : book.name);
      insertItem.run(chargeId, book.id, qty, book.price, lineAmount);
    }

    updateTotal.run(totalAmount, chargeId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // SMS 발송 시뮬레이션 (체크되어 있으면)
  if (send_sms === 'on' || send_sms === 'true') {
    const template = getDefaultTemplate('charge_notice');
    const message = renderTemplate(template.content, {
      studentName: student.name,
      bookNames: bookNamesUsed.join(', '),
      amount: totalAmount,
      account: getAccountInfo(),
      dueDate: due_date,
    });
    sendSms({
      chargeId,
      studentId: student.id,
      templateType: 'charge_notice',
      recipientPhone: student.parent_phone,
      messageContent: message,
      sentBy: req.session.adminId,
    });
  }

  res.redirect(`/charges/${chargeId}?flash=` + encodeURIComponent('청구가 생성되었습니다.' + (send_sms ? ' (안내 SMS 발송됨)' : '')));
});

// ---------- 상세 ----------
router.get('/charges/:id', requireAuth, (req, res) => {
  const charge = db.prepare(`
    SELECT c.*, s.name as student_name, s.school_name, s.grade, s.parent_name, s.parent_phone
    FROM charge c JOIN student s ON s.id = c.student_id
    WHERE c.id = ?
  `).get(req.params.id);

  if (!charge) {
    return res.redirect('/charges?flash=' + encodeURIComponent('청구를 찾을 수 없습니다.') + '&flashType=error');
  }

  const items = db.prepare(`
    SELECT ci.*, bk.name as book_name, bk.subject
    FROM charge_item ci JOIN book bk ON bk.id = ci.book_id
    WHERE ci.charge_id = ?
  `).all(charge.id);

  const matches = db.prepare(`
    SELECT cpm.*, pt.txn_datetime, pt.depositor_name, pt.amount as txn_amount
    FROM charge_payment_match cpm JOIN payment_txn pt ON pt.id = cpm.payment_txn_id
    WHERE cpm.charge_id = ?
    ORDER BY cpm.matched_at
  `).all(charge.id);

  const totalMatched = matches.reduce((sum, m) => sum + m.matched_amount, 0);

  const smsLogs = db.prepare(`
    SELECT * FROM sms_log WHERE charge_id = ? ORDER BY sent_at DESC
  `).all(charge.id);

  res.render('charges/show', {
    pageTitle: `청구 상세 #${charge.id}`,
    active: 'charges',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    charge,
    items,
    matches,
    totalMatched,
    smsLogs,
    statusLabel: STATUS_LABEL,
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

// ---------- 안내 SMS 재발송 ----------
router.post('/charges/:id/send-sms', requireAuth, (req, res) => {
  const charge = db.prepare(`
    SELECT c.*, s.name as student_name, s.parent_phone
    FROM charge c JOIN student s ON s.id = c.student_id WHERE c.id = ?
  `).get(req.params.id);

  if (!charge) {
    return res.redirect('/charges?flash=' + encodeURIComponent('청구를 찾을 수 없습니다.') + '&flashType=error');
  }

  const items = db.prepare(`
    SELECT ci.*, bk.name as book_name FROM charge_item ci JOIN book bk ON bk.id = ci.book_id WHERE ci.charge_id = ?
  `).all(charge.id);
  const bookNames = items.map(i => i.quantity > 1 ? `${i.book_name} x${i.quantity}` : i.book_name).join(', ');

  const templateType = charge.status === 'overdue' ? 'overdue_notice' : 'charge_notice';
  const template = getDefaultTemplate(templateType);
  const message = renderTemplate(template.content, {
    studentName: charge.student_name,
    bookNames,
    amount: charge.total_amount,
    account: getAccountInfo(),
    dueDate: charge.due_date,
  });

  sendSms({
    chargeId: charge.id,
    studentId: charge.student_id,
    templateType,
    recipientPhone: charge.parent_phone,
    messageContent: message,
    sentBy: req.session.adminId,
  });

  res.redirect(`/charges/${charge.id}?flash=` + encodeURIComponent('안내 SMS가 발송되었습니다.'));
});

// ---------- 청구 취소 ----------
router.post('/charges/:id/cancel', requireAuth, (req, res) => {
  db.prepare(`UPDATE charge SET status='canceled', updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.redirect('/charges?flash=' + encodeURIComponent('청구가 취소되었습니다.'));
});

module.exports = router;
