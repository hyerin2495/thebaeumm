const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parseUploadedFile } = require('../services/payment');
const { extractStudents, checkDuplicates, saveStudentsBulk } = require('../services/studentImport');

const router = express.Router();
const PAGE_SIZE = 15;

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error('지원하지 않는 파일 형식입니다.'));
  },
});

// 업로드된 학생 명단을 잠깐 들고 있을 메모리 캐시 (입금관리와 동일한 패턴)
const pendingStudentUploads = new Map();

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

// ============================================================
// 엑셀 일괄등록 (업로드 → 컬럼매핑 → 미리보기 → 확정), 입금관리와 동일한 패턴
// ============================================================

// ---------- 업로드 폼 ----------
router.get('/students/import', requireAuth, (req, res) => {
  res.render('students/import-upload', {
    pageTitle: '학생 명단 일괄등록',
    active: 'students',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

// ---------- 업로드 처리 → 컬럼 매핑 화면으로 ----------
router.post('/students/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.render('students/import-upload', {
      pageTitle: '학생 명단 일괄등록',
      active: 'students',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      flash: { type: 'error', message: '파일을 선택해주세요.' },
    });
  }

  try {
    const rows = await parseUploadedFile(req.file.path, req.file.originalname);
    fs.unlinkSync(req.file.path);

    if (rows.length === 0) {
      return res.render('students/import-upload', {
        pageTitle: '학생 명단 일괄등록',
        active: 'students',
        adminName: req.session.adminName,
        adminRole: req.session.adminRole,
        flash: { type: 'error', message: '파일에 데이터가 없습니다.' },
      });
    }

    const uploadId = `student_upload_${Date.now()}`;
    pendingStudentUploads.set(uploadId, { rows, originalName: req.file.originalname });
    setTimeout(() => pendingStudentUploads.delete(uploadId), 5 * 60 * 1000);

    res.render('students/import-mapping', {
      pageTitle: '학생 명단 컬럼 매핑',
      active: 'students',
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
    res.render('students/import-upload', {
      pageTitle: '학생 명단 일괄등록',
      active: 'students',
      adminName: req.session.adminName,
      adminRole: req.session.adminRole,
      flash: { type: 'error', message: '파일 처리 중 오류: ' + err.message },
    });
  }
});

// ---------- 매핑 확정 → 미리보기(중복체크 포함) ----------
router.post('/students/import/mapping', requireAuth, (req, res) => {
  const { uploadId, col_name, col_school, col_grade, col_student_phone, col_parent_name, col_parent_phone, col_memo, has_header } = req.body;

  const pending = pendingStudentUploads.get(uploadId);
  if (!pending) {
    return res.redirect('/students/import?flash=' + encodeURIComponent('업로드 세션이 만료되었습니다. 다시 업로드해주세요.') + '&flashType=error');
  }

  const toIdx = (v) => (v !== '' && v != null ? parseInt(v, 10) : null);
  const mapping = {
    name: toIdx(col_name),
    school: toIdx(col_school),
    grade: toIdx(col_grade),
    studentPhone: toIdx(col_student_phone),
    parentName: toIdx(col_parent_name),
    parentPhone: toIdx(col_parent_phone),
    memo: toIdx(col_memo),
  };
  const hasHeader = has_header === 'on' || has_header === 'true';

  const { results, errors } = extractStudents(pending.rows, mapping, hasHeader);
  const withDupCheck = checkDuplicates(results);

  pending.extracted = withDupCheck;
  pending.errors = errors;

  const duplicateCount = withDupCheck.filter(s => s.isDuplicate).length;

  res.render('students/import-preview', {
    pageTitle: '학생 명단 등록 확인',
    active: 'students',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    uploadId,
    originalName: pending.originalName,
    students: withDupCheck.slice(0, 100),
    totalCount: withDupCheck.length,
    duplicateCount,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
    flash: null,
  });
});

// ---------- 최종 저장 ----------
router.post('/students/import/confirm', requireAuth, (req, res) => {
  const { uploadId, skip_duplicates } = req.body;
  const pending = pendingStudentUploads.get(uploadId);

  if (!pending || !pending.extracted) {
    return res.redirect('/students/import?flash=' + encodeURIComponent('업로드 세션이 만료되었습니다. 다시 업로드해주세요.') + '&flashType=error');
  }

  const skipDuplicates = skip_duplicates === 'on' || skip_duplicates === 'true';
  const result = saveStudentsBulk(pending.extracted, skipDuplicates);
  pendingStudentUploads.delete(uploadId);

  const message = `${result.inserted}명 등록 완료` + (result.skipped > 0 ? ` (중복 제외 ${result.skipped}명)` : '');
  res.redirect('/students?flash=' + encodeURIComponent(message));
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
