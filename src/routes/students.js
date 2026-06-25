const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const PAGE_SIZE = 15;

// ---------- 목록 ----------
router.get('/students', requireAuth, (req, res) => {
  const { keyword = '', school = '', grade = '', status = 'active' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);

  const conditions = [];
  const params = {};

  if (keyword) {
    conditions.push('(s.name LIKE @kw OR s.parent_name LIKE @kw OR s.parent_phone LIKE @kw)');
    params.kw = `%${keyword}%`;
  }
  if (school) {
    conditions.push('s.school_name = @school');
    params.school = school;
  }
  if (grade) {
    conditions.push('s.grade = @grade');
    params.grade = grade;
  }
  if (status && status !== 'all') {
    conditions.push('s.status = @status');
    params.status = status;
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM student s ${whereClause}`).get(params);
  const total = totalRow.cnt;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const students = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM charge c WHERE c.student_id = s.id AND c.status='overdue') as overdue_count
    FROM student s
    ${whereClause}
    ORDER BY s.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: PAGE_SIZE, offset });

  const schoolList = db.prepare(`SELECT DISTINCT school_name FROM student WHERE school_name IS NOT NULL ORDER BY school_name`).all();
  const gradeList = db.prepare(`SELECT DISTINCT grade FROM student WHERE grade IS NOT NULL ORDER BY grade`).all();

  res.render('students/index', {
    pageTitle: '학생 관리',
    active: 'students',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    students,
    schoolList,
    gradeList,
    filters: { keyword, school, grade, status },
    pagination: { page: safePage, totalPages, total },
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

// ---------- 등록 폼 ----------
router.get('/students/new', requireAuth, (req, res) => {
  res.render('students/form', {
    pageTitle: '학생 등록',
    active: 'students',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    student: null,
    formAction: '/students',
    flash: null,
  });
});

// ---------- 등록 처리 ----------
router.post('/students', requireAuth, (req, res) => {
  const { name, school_name, grade, student_phone, parent_name, parent_phone, memo } = req.body;

  if (!name || !parent_phone) {
    return res.render('students/form', {
      pageTitle: '학생 등록',
      active: 'students',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      student: req.body,
      formAction: '/students',
      flash: { type: 'error', message: '학생명과 학부모 연락처는 필수입니다.' },
    });
  }

  db.prepare(`
    INSERT INTO student (name, school_name, grade, student_phone, parent_name, parent_phone, memo, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(name, school_name || null, grade || null, student_phone || null, parent_name || null, parent_phone, memo || null);

  res.redirect('/students?flash=' + encodeURIComponent(`${name} 학생이 등록되었습니다.`));
});

// ---------- 수정 폼 ----------
router.get('/students/:id/edit', requireAuth, (req, res) => {
  const student = db.prepare('SELECT * FROM student WHERE id = ?').get(req.params.id);
  if (!student) return res.redirect('/students?flash=' + encodeURIComponent('학생을 찾을 수 없습니다.') + '&flashType=error');

  res.render('students/form', {
    pageTitle: '학생 정보 수정',
    active: 'students',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    student,
    formAction: `/students/${student.id}`,
    flash: null,
  });
});

// ---------- 수정 처리 ----------
router.post('/students/:id', requireAuth, (req, res) => {
  const { name, school_name, grade, student_phone, parent_name, parent_phone, memo } = req.body;
  const id = req.params.id;

  if (!name || !parent_phone) {
    const student = db.prepare('SELECT * FROM student WHERE id = ?').get(id);
    return res.render('students/form', {
      pageTitle: '학생 정보 수정',
      active: 'students',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      student: { ...student, ...req.body },
      formAction: `/students/${id}`,
      flash: { type: 'error', message: '학생명과 학부모 연락처는 필수입니다.' },
    });
  }

  db.prepare(`
    UPDATE student
    SET name=?, school_name=?, grade=?, student_phone=?, parent_name=?, parent_phone=?, memo=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, school_name || null, grade || null, student_phone || null, parent_name || null, parent_phone, memo || null, id);

  res.redirect('/students?flash=' + encodeURIComponent('학생 정보가 수정되었습니다.'));
});

// ---------- 소프트 삭제 (퇴원 처리) ----------
router.post('/students/:id/deactivate', requireAuth, (req, res) => {
  const id = req.params.id;
  db.prepare(`UPDATE student SET status='inactive', updated_at=datetime('now') WHERE id=?`).run(id);
  res.redirect('/students?flash=' + encodeURIComponent('퇴원 처리되었습니다.'));
});

// ---------- 복귀 처리 ----------
router.post('/students/:id/reactivate', requireAuth, (req, res) => {
  const id = req.params.id;
  db.prepare(`UPDATE student SET status='active', updated_at=datetime('now') WHERE id=?`).run(id);
  res.redirect('/students?flash=' + encodeURIComponent('재원 상태로 복귀되었습니다.'));
});

module.exports = router;
