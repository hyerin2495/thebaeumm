const db = require('../db');

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

async function checkDuplicates(students) {
  return Promise.all(students.map(async (s) => {
    const existing = await db.get(
      'SELECT id FROM student WHERE name = ? AND parent_phone = ?',
      [s.name, s.parentPhone]
    );
    return { ...s, isDuplicate: !!existing, existingId: existing ? existing.id : null };
  }));
}

async function saveStudentsBulk(students, skipDuplicates) {
  let inserted = 0;
  let skipped = 0;

  await db.transaction(async (conn) => {
    for (const s of students) {
      if (skipDuplicates && s.isDuplicate) {
        skipped++;
        continue;
      }
      await conn.run(
        `INSERT INTO student (name, school_name, grade, student_phone, parent_name, parent_phone, memo, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [s.name, s.schoolName, s.grade, s.studentPhone, s.parentName, s.parentPhone, s.memo]
      );
      inserted++;
    }
  });

  return { inserted, skipped, total: students.length };
}

module.exports = { extractStudents, checkDuplicates, saveStudentsBulk };
