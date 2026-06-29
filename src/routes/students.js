const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parseUploadedFile } = require('../services/payment');
const { extractStudents, checkDuplicates, saveStudentsBulk } = require('../services/studentImport');

const router = express.Router();
const PAGE_SIZE = 15;

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

const pendingStudentUploads = new Map();

router.get('/students', requireAuth, async (req, res) => {
  const { keyword = '', school = '', grade = '', class_name = '', status = 'active' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);

  const conditions = [];
  const params = [];

  if (keyword) {
    conditions.push('(s.name LIKE ? OR s.parent_name LIKE ? OR s.parent_phone LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (school) {
    conditions.push('s.school_name = ?');
    params.push(school);
  }
  if (grade) {
    conditions.push('s.grade = ?');
    params.push(grade);
  }
  if (class_name) {
    conditions.push('s.class_name = ?');
    params.push(class_name);
  }
  if (status && status !== 'all') {
    conditions.push('s.status = ?');
    params.push(status);
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = await db.get(`SELECT COUNT(*) as cnt FROM student s ${whereClause}`, params);
  const total = totalRow.cnt;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const students = await db.all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM charge c WHERE c.student_id = s.id AND c.status='overdue') as overdue_count
    FROM student s
    ${whereClause}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `, [...params, PAGE_SIZE, offset]);

  const schoolList = await db.all(`SELECT DISTINCT school_name FROM student WHERE school_name IS NOT NULL ORDER BY school_name`);
  const gradeList = await db.all(`SELECT DISTINCT grade FROM student WHERE grade IS NOT NULL ORDER BY grade`);
  const classList = await db.all(`SELECT DISTINCT class_name FROM student WHERE class_name IS NOT NULL ORDER BY class_name`);

  res.render('students/index', {
    pageTitle: '학생 관리',
    active: 'students',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    students,
    schoolList,
    gradeList,
    classList,
    filters: { keyword, school, grade, class_name, status },
    pagination: { page: safePage, totalPages, total },
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

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

router.post('/students', requireAuth, async (req, res) => {
  const { name, school_name, grade, class_name, student_phone, parent_name, parent_phone, memo } = req.body;

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

  await db.run(
    `INSERT INTO student (name, school_name, grade, class_name, student_phone, parent_name, parent_phone, memo, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [name, school_name || null, grade || null, class_name || null, student_phone || null, parent_name || null, parent_phone, memo || null]
  );

  res.redirect('/students?flash=' + encodeURIComponent(`${name} 학생이 등록되었습니다.`));
});

// ============================================================
// 엑셀 일괄등록
// ============================================================

router.get('/students/import', requireAuth, (req, res) => {
  res.render('students/import-upload', {
    pageTitle: '학생 명단 일괄등록',
    active: 'students',
    adminName: req.session.adminName,
    adminRole: req.session.adminRole,
    flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
  });
});

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

router.post('/students/import/mapping', requireAuth, async (req, res) => {
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
  const withDupCheck = await checkDuplicates(results);

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

router.post('/students/import/confirm', requireAuth, async (req, res) => {
  const { uploadId, skip_duplicates } = req.body;
  const pending = pendingStudentUploads.get(uploadId);

  if (!pending || !pending.extracted) {
    return res.redirect('/students/import?flash=' + encodeURIComponent('업로드 세션이 만료되었습니다. 다시 업로드해주세요.') + '&flashType=error');
  }

  const skipDuplicates = skip_duplicates === 'on' || skip_duplicates === 'true';
  const result = await saveStudentsBulk(pending.extracted, skipDuplicates);
  pendingStudentUploads.delete(uploadId);

  const message = `${result.inserted}명 등록 완료` + (result.skipped > 0 ? ` (중복 제외 ${result.skipped}명)` : '');
  res.redirect('/students?flash=' + encodeURIComponent(message));
});

router.post('/students/send-sms-bulk', requireAuth, async (req, res) => {
  const { message, send_mode, student_ids, filter_school, filter_grade, filter_class, filter_status } = req.body;
  const { sendSms } = require('../services/sms');

  if (!message || !message.trim()) {
    return res.redirect('/students?flash=' + encodeURIComponent('발송할 메시지를 입력해주세요.') + '&flashType=error');
  }

  let students = [];

  if (send_mode === 'filter') {
    const conditions = [];
    const params = [];
    const st = filter_status || 'active';
    if (st !== 'all') { conditions.push('status = ?'); params.push(st); }
    if (filter_school) { conditions.push('school_name = ?'); params.push(filter_school); }
    if (filter_grade) { conditions.push('grade = ?'); params.push(filter_grade); }
    if (filter_class) { conditions.push('class_name = ?'); params.push(filter_class); }
    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    students = await db.all(`SELECT id, name, parent_phone FROM student ${whereClause}`, params);
  } else {
    const ids = Array.isArray(student_ids) ? student_ids : (student_ids ? [student_ids] : []);
    if (ids.length === 0) {
      return res.redirect('/students?flash=' + encodeURIComponent('발송할 학생을 선택해주세요.') + '&flashType=error');
    }
    const placeholders = ids.map(() => '?').join(',');
    students = await db.all(`SELECT id, name, parent_phone FROM student WHERE id IN (${placeholders})`, ids);
  }

  if (students.length === 0) {
    return res.redirect('/students?flash=' + encodeURIComponent('발송 대상 학생이 없습니다.') + '&flashType=error');
  }

  let successCount = 0;
  for (const student of students) {
    if (!student.parent_phone) continue;
    const personalizedMessage = message.trim().replace(/\{학생명\}/g, student.name);
    await sendSms({
      chargeId: null,
      studentId: student.id,
      templateType: 'custom',
      recipientPhone: student.parent_phone,
      messageContent: personalizedMessage,
      sentBy: req.session.adminId,
    });
    successCount++;
  }

  res.redirect('/students?flash=' + encodeURIComponent(`${successCount}명의 학부모에게 문자를 발송했습니다.`));
});

router.get('/students/:id/edit', requireAuth, async (req, res) => {
  const student = await db.get('SELECT * FROM student WHERE id = ?', [req.params.id]);
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

router.post('/students/:id', requireAuth, async (req, res) => {
  const { name, school_name, grade, class_name, student_phone, parent_name, parent_phone, memo } = req.body;
  const id = req.params.id;

  if (!name || !parent_phone) {
    const student = await db.get('SELECT * FROM student WHERE id = ?', [id]);
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

  await db.run(
    `UPDATE student SET name=?, school_name=?, grade=?, class_name=?, student_phone=?, parent_name=?, parent_phone=?, memo=?, updated_at=NOW() WHERE id=?`,
    [name, school_name || null, grade || null, class_name || null, student_phone || null, parent_name || null, parent_phone, memo || null, id]
  );

  res.redirect('/students?flash=' + encodeURIComponent('학생 정보가 수정되었습니다.'));
});

router.post('/students/:id/deactivate', requireAuth, async (req, res) => {
  await db.run(`UPDATE student SET status='inactive', updated_at=NOW() WHERE id=?`, [req.params.id]);
  res.redirect('/students?flash=' + encodeURIComponent('퇴원 처리되었습니다.'));
});

router.post('/students/:id/reactivate', requireAuth, async (req, res) => {
  await db.run(`UPDATE student SET status='active', updated_at=NOW() WHERE id=?`, [req.params.id]);
  res.redirect('/students?flash=' + encodeURIComponent('재원 상태로 복귀되었습니다.'));
});

module.exports = router;
