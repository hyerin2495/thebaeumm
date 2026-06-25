const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const PAGE_SIZE = 15;

// ---------- 목록 ----------
router.get('/books', requireAuth, (req, res) => {
  const { keyword = '', subject = '', status = 'active' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);

  const conditions = [];
  const params = {};

  if (keyword) {
    conditions.push('(b.name LIKE @kw OR b.publisher LIKE @kw)');
    params.kw = `%${keyword}%`;
  }
  if (subject) {
    conditions.push('b.subject = @subject');
    params.subject = subject;
  }
  if (status && status !== 'all') {
    conditions.push('b.status = @status');
    params.status = status;
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM book b ${whereClause}`).get(params);
  const total = totalRow.cnt;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const books = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM charge_item ci WHERE ci.book_id = b.id) as used_count
    FROM book b
    ${whereClause}
    ORDER BY b.subject, b.name
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: PAGE_SIZE, offset });

  const subjectList = db.prepare(`SELECT DISTINCT subject FROM book WHERE subject IS NOT NULL ORDER BY subject`).all();

  res.render('books/index', {
    pageTitle: '교재 관리',
    active: 'books',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    books,
    subjectList,
    filters: { keyword, subject, status },
    pagination: { page: safePage, totalPages, total },
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

// ---------- 등록 폼 ----------
router.get('/books/new', requireAuth, (req, res) => {
  res.render('books/form', {
    pageTitle: '교재 등록',
    active: 'books',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    book: null,
    formAction: '/books',
    flash: null,
  });
});

// ---------- 등록 처리 ----------
router.post('/books', requireAuth, (req, res) => {
  const { name, subject, publisher, price } = req.body;
  const priceNum = parseInt(price, 10);

  if (!name || !priceNum || priceNum <= 0) {
    return res.render('books/form', {
      pageTitle: '교재 등록',
      active: 'books',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      book: req.body,
      formAction: '/books',
      flash: { type: 'error', message: '교재명과 단가(0보다 큰 숫자)는 필수입니다.' },
    });
  }

  db.prepare(`
    INSERT INTO book (name, subject, publisher, price, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(name, subject || null, publisher || null, priceNum);

  res.redirect('/books?flash=' + encodeURIComponent(`${name} 교재가 등록되었습니다.`));
});

// ---------- 수정 폼 ----------
router.get('/books/:id/edit', requireAuth, (req, res) => {
  const book = db.prepare('SELECT * FROM book WHERE id = ?').get(req.params.id);
  if (!book) return res.redirect('/books?flash=' + encodeURIComponent('교재를 찾을 수 없습니다.') + '&flashType=error');

  res.render('books/form', {
    pageTitle: '교재 정보 수정',
    active: 'books',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    book,
    formAction: `/books/${book.id}`,
    flash: null,
  });
});

// ---------- 수정 처리 ----------
router.post('/books/:id', requireAuth, (req, res) => {
  const { name, subject, publisher, price } = req.body;
  const id = req.params.id;
  const priceNum = parseInt(price, 10);

  if (!name || !priceNum || priceNum <= 0) {
    const book = db.prepare('SELECT * FROM book WHERE id = ?').get(id);
    return res.render('books/form', {
      pageTitle: '교재 정보 수정',
      active: 'books',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      book: { ...book, ...req.body },
      formAction: `/books/${id}`,
      flash: { type: 'error', message: '교재명과 단가(0보다 큰 숫자)는 필수입니다.' },
    });
  }

  db.prepare(`
    UPDATE book SET name=?, subject=?, publisher=?, price=?, updated_at=datetime('now') WHERE id=?
  `).run(name, subject || null, publisher || null, priceNum, id);

  res.redirect('/books?flash=' + encodeURIComponent('교재 정보가 수정되었습니다. (※ 기존 청구건의 단가는 변경되지 않습니다)'));
});

// ---------- 비활성화 ----------
router.post('/books/:id/deactivate', requireAuth, (req, res) => {
  db.prepare(`UPDATE book SET status='inactive', updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.redirect('/books?flash=' + encodeURIComponent('교재가 비활성화되었습니다.'));
});

// ---------- 재활성화 ----------
router.post('/books/:id/reactivate', requireAuth, (req, res) => {
  db.prepare(`UPDATE book SET status='active', updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.redirect('/books?flash=' + encodeURIComponent('교재가 다시 활성화되었습니다.'));
});

module.exports = router;
