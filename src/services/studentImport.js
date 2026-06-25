const db = require('../db');

/**
 * 학생 일괄등록용 컬럼 매핑 → 정규화된 학생 객체 배열로 변환.
 * mapping: { name, school, grade, studentPhone, parentName, parentPhone, memo } 각각 colIndex 또는 null
 * name, parentPhone은 필수. 나머지는 선택.
 */
function extractStudents(rows, mapping, hasHeader) {
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const results = [];
  const errors = [];

  const get = (row, key) => {
    const idx = mapping[key];
    if (idx == null || idx === '') return null;
    const v = row[idx];
    return v != null ? String(v).trim() : null;
  };

  dataRows.forEach((row, idx) => {
    const name = get(row, 'name');
    const parentPhone = get(row, 'parentPhone');

    if (!name || !parentPhone) {
      errors.push({ rowIndex: idx + (hasHeader ? 2 : 1), raw: row, reason: '학생명 또는 학부모연락처 누락' });
      return;
    }

    results.push({
      name,
      schoolName: get(row, 'school'),
      grade: get(row, 'grade'),
      studentPhone: get(row, 'studentPhone'),
      parentName: get(row, 'parentName'),
      parentPhone,
      memo: get(row, 'memo'),
    });
  });

  return { results, errors };
}

/**
 * 중복 판단: 학생명 + 학부모연락처 조합이 이미 DB에 있는지 확인.
 * (형제는 학부모연락처만 같고 학생명이 다르므로 정상적으로 별개 학생으로 취급됨)
 */
function checkDuplicates(students) {
  return students.map(s => {
    const existing = db.prepare(`
      SELECT id FROM student WHERE name = ? AND parent_phone = ?
    `).get(s.name, s.parentPhone);
    return { ...s, isDuplicate: !!existing, existingId: existing ? existing.id : null };
  });
}

/**
 * 일괄 저장. skipDuplicates가 true면 중복 학생은 건너뛰고, false면 중복이어도 새로 등록(별개 row로 추가).
 */
function saveStudentsBulk(students, skipDuplicates) {
  const insertStudent = db.prepare(`
    INSERT INTO student (name, school_name, grade, student_phone, parent_name, parent_phone, memo, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `);

  let inserted = 0;
  let skipped = 0;

  db.exec('BEGIN');
  try {
    for (const s of students) {
      if (skipDuplicates && s.isDuplicate) {
        skipped++;
        continue;
      }
      insertStudent.run(s.name, s.schoolName, s.grade, s.studentPhone, s.parentName, s.parentPhone, s.memo);
      inserted++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { inserted, skipped, total: students.length };
}

module.exports = { extractStudents, checkDuplicates, saveStudentsBulk };
