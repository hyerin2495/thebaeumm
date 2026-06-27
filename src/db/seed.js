require('dotenv').config();
const { faker } = require('@faker-js/faker');
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const db = require('./index.js');

faker.seed(2026);

async function main() {
  // ============================================================
  // 0. 기존 데이터 초기화
  // ============================================================
  const tables = [
    'sms_log', 'charge_payment_match', 'payment_txn',
    'charge_item', 'charge', 'sms_template', 'app_setting', 'book', 'student', 'admin_user',
  ];
  for (const t of tables) {
    await db.run(`DELETE FROM ${t}`);
  }

  // ============================================================
  // 1. 관리자 계정
  // ============================================================
  const directorHash = bcrypt.hashSync('director123', 10);
  const staffHash = bcrypt.hashSync('staff123', 10);

  const admin1 = await db.run(
    'INSERT INTO admin_user (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
    ['director', directorHash, '김원장', 'director']
  );
  const admin2 = await db.run(
    'INSERT INTO admin_user (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
    ['staff1', staffHash, '이직원', 'staff']
  );
  const adminIds = [admin1.insertId, admin2.insertId];
  console.log('✓ 관리자 계정 2명 생성');

  // ============================================================
  // 2. 학생 70명
  // ============================================================
  const schools = [
    '아산중학교', '온양중학교', '신정중학교', '탕정중학교', '배방중학교',
    '아산고등학교', '온양고등학교', '신정고등학교', '충남고등학교', '배방고등학교',
  ];
  const middleGrades = ['중1', '중2', '중3'];
  const highGrades = ['고1', '고2', '고3'];
  const koreanLastNames = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임'];
  const koreanFirstNames = [
    '민준', '서연', '도윤', '하은', '시우', '지우', '주원', '서윤', '예준', '지유',
    '민서', '수아', '지호', '윤서', '준서', '채원', '현우', '소율', '건우', '다은',
    '우진', '나은', '선우', '예린', '연우', '시은', '정우', '유나', '승현', '아린',
  ];

  function randomKoreanName() {
    return faker.helpers.arrayElement(koreanLastNames) + faker.helpers.arrayElement(koreanFirstNames);
  }
  function randomPhone() {
    return `010-${faker.string.numeric(4)}-${faker.string.numeric(4)}`;
  }

  const STUDENT_COUNT = 70;
  const studentIds = [];

  for (let i = 0; i < STUDENT_COUNT; i++) {
    const isHigh = faker.datatype.boolean({ probability: 0.45 });
    const school = faker.helpers.arrayElement(isHigh ? schools.slice(5) : schools.slice(0, 5));
    const grade = faker.helpers.arrayElement(isHigh ? highGrades : middleGrades);
    const studentName = randomKoreanName();
    const parentName = studentName[0] + faker.helpers.arrayElement(['민', '영', '수', '진', '경']) + faker.helpers.arrayElement(['수', '희', '호', '자', '란']);
    const status = faker.datatype.boolean({ probability: 0.93 }) ? 'active' : 'inactive';
    const createdAt = dayjs().subtract(faker.number.int({ min: 10, max: 240 }), 'day').format('YYYY-MM-DD HH:mm:ss');

    const result = await db.run(
      'INSERT INTO student (name, school_name, grade, student_phone, parent_name, parent_phone, memo, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        studentName, school, grade,
        faker.datatype.boolean({ probability: 0.6 }) ? randomPhone() : null,
        parentName, randomPhone(),
        faker.datatype.boolean({ probability: 0.15 }) ? '형제 동시 등록' : null,
        status, createdAt,
      ]
    );
    studentIds.push({ id: result.insertId, createdAt, status, name: studentName, parentName });
  }
  console.log(`✓ 학생 ${STUDENT_COUNT}명 생성`);

  // ============================================================
  // 3. 교재 18종
  // ============================================================
  const englishBooks = [
    { name: '능률 중학영어 1', price: 14000 }, { name: '능률 중학영어 2', price: 14000 },
    { name: '능률 중학영어 3', price: 14500 }, { name: '리딩튜터 입문', price: 16000 },
    { name: '리딩튜터 기본', price: 17000 }, { name: '쎄듀 어휘끝 중등', price: 13000 },
    { name: '천일문 입문편', price: 18000 }, { name: '고등영어 독해 기본', price: 15500 },
    { name: '수능특강 영어', price: 16500 },
  ];
  const mathBooks = [
    { name: '개념원리 중학수학 1-1', price: 15000 }, { name: '개념원리 중학수학 2-1', price: 15000 },
    { name: '개념원리 중학수학 3-1', price: 15500 }, { name: '쎈 중등수학 1상', price: 16000 },
    { name: '쎈 중등수학 2상', price: 16000 }, { name: '수학의 정석 (실력)', price: 19000 },
    { name: '高 수학 I', price: 17500 }, { name: '高 수학 II', price: 17500 },
    { name: '수능특강 수학', price: 18500 },
  ];
  const engPublishers = ['능률교육', '쎄듀', 'NE능률', '비상교육'];
  const mathPublishers = ['개념원리수학연구소', '좋은책신사고', '성지출판', 'EBS'];

  const bookIds = [];
  for (const b of englishBooks) {
    const r = await db.run(
      'INSERT INTO book (name, subject, publisher, price, status) VALUES (?, ?, ?, ?, ?)',
      [b.name, '영어', faker.helpers.arrayElement(engPublishers), b.price, 'active']
    );
    bookIds.push({ id: r.insertId, price: b.price });
  }
  for (const b of mathBooks) {
    const r = await db.run(
      'INSERT INTO book (name, subject, publisher, price, status) VALUES (?, ?, ?, ?, ?)',
      [b.name, '수학', faker.helpers.arrayElement(mathPublishers), b.price, 'active']
    );
    bookIds.push({ id: r.insertId, price: b.price });
  }
  console.log(`✓ 교재 ${bookIds.length}종 생성`);

  // ============================================================
  // 4. SMS 템플릿 + 앱 설정
  // ============================================================
  await db.run(
    'INSERT INTO sms_template (type, name, content, is_default) VALUES (?, ?, ?, ?)',
    ['charge_notice', '교재비 안내 (기본)', '[EduBill] {학생명} 학생 교재비 안내\n교재: {교재명}\n금액: {금액}원\n입금계좌: {계좌}\n입금기한: {기한}\n문의: 학원 데스크', 1]
  );
  await db.run(
    'INSERT INTO sms_template (type, name, content, is_default) VALUES (?, ?, ?, ?)',
    ['overdue_notice', '미납 안내 (기본)', '[EduBill] {학생명} 학생 교재비 미납 안내\n금액: {금액}원\n입금기한이 지났습니다. 빠른 입금 부탁드립니다.\n입금계좌: {계좌}\n문의: 학원 데스크', 1]
  );

  const ACCOUNT_INFO = '농협 123-456-789012 (EduBill)';
  await db.run('INSERT INTO app_setting (setting_key, setting_value) VALUES (?, ?)', ['account_info', ACCOUNT_INFO]);
  await db.run('INSERT INTO app_setting (setting_key, setting_value) VALUES (?, ?)', ['sms_api_provider', 'aligo']);
  await db.run('INSERT INTO app_setting (setting_key, setting_value) VALUES (?, ?)', ['sms_api_key', '']);
  await db.run('INSERT INTO app_setting (setting_key, setting_value) VALUES (?, ?)', ['sms_sender_number', '']);
  console.log('✓ SMS 템플릿 + 앱 설정 생성');

  // ============================================================
  // 5. 청구 + 청구상세
  // ============================================================
  const today = dayjs();
  const activeStudents = studentIds.filter(s => s.status === 'active');
  const charges = [];

  for (const student of activeStudents) {
    const chargeCount = faker.number.int({ min: 1, max: 3 });
    for (let c = 0; c < chargeCount; c++) {
      const selectedBooks = faker.helpers.arrayElements(bookIds, faker.number.int({ min: 1, max: 3 }));
      let totalAmount = 0;
      const items = selectedBooks.map(b => {
        totalAmount += b.price;
        return { bookId: b.id, unitPrice: b.price, lineAmount: b.price };
      });

      let createdAt = dayjs(student.createdAt).add(faker.number.int({ min: 5, max: 200 }), 'day');
      if (createdAt.isAfter(today)) createdAt = today.subtract(faker.number.int({ min: 1, max: 60 }), 'day');

      const roll = faker.number.float({ min: 0, max: 1 });
      let status = roll < 0.50 ? 'paid' : roll < 0.75 ? 'overdue' : roll < 0.90 ? 'unpaid' : 'partial';

      let finalDueDate;
      if (status === 'overdue') finalDueDate = today.subtract(faker.number.int({ min: 1, max: 30 }), 'day');
      else if (status === 'unpaid') finalDueDate = today.add(faker.number.int({ min: 1, max: 10 }), 'day');
      else {
        finalDueDate = createdAt.add(7, 'day');
        if (finalDueDate.isAfter(today.subtract(1, 'day'))) finalDueDate = today.subtract(faker.number.int({ min: 2, max: 20 }), 'day');
      }

      const chargeResult = await db.run(
        'INSERT INTO charge (student_id, total_amount, due_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [student.id, totalAmount, finalDueDate.format('YYYY-MM-DD'), status, faker.helpers.arrayElement(adminIds), createdAt.format('YYYY-MM-DD HH:mm:ss'), createdAt.format('YYYY-MM-DD HH:mm:ss')]
      );
      const chargeId = chargeResult.insertId;

      for (const item of items) {
        await db.run(
          'INSERT INTO charge_item (charge_id, book_id, quantity, unit_price, line_amount) VALUES (?, ?, ?, ?, ?)',
          [chargeId, item.bookId, 1, item.unitPrice, item.lineAmount]
        );
      }

      charges.push({ id: chargeId, studentId: student.id, totalAmount, dueDate: finalDueDate, status, createdAt, studentName: student.name, parentName: student.parentName });
    }
  }
  console.log(`✓ 청구 ${charges.length}건 생성`);

  // ============================================================
  // 6. 입금 거래내역 + 매칭
  // ============================================================
  const SOURCE_FILE = 'nh_transactions_202606.xlsx';
  let txnSeq = 0;

  for (const charge of charges) {
    if (charge.status === 'paid') {
      const txnDatetime = dayjs(charge.createdAt).add(faker.number.int({ min: 1, max: 5 }), 'day').format('YYYY-MM-DD HH:mm:ss');
      const dedupeKey = `${txnDatetime}_${charge.totalAmount}_${charge.parentName}_${++txnSeq}`;
      const txn = await db.run(
        'INSERT INTO payment_txn (txn_datetime, depositor_name, amount, memo, source_file, dedupe_key, match_status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [txnDatetime, charge.parentName, charge.totalAmount, '교재비', SOURCE_FILE, dedupeKey, 'matched', faker.helpers.arrayElement(adminIds), txnDatetime]
      );
      await db.run(
        'INSERT INTO charge_payment_match (charge_id, payment_txn_id, matched_amount, match_type, matched_by, matched_at) VALUES (?, ?, ?, ?, ?, ?)',
        [charge.id, txn.insertId, charge.totalAmount, 'auto', faker.helpers.arrayElement(adminIds), txnDatetime]
      );
    } else if (charge.status === 'partial') {
      const partialAmount = Math.round(charge.totalAmount * faker.number.float({ min: 0.4, max: 0.7 }) / 100) * 100;
      const txnDatetime = dayjs(charge.createdAt).add(faker.number.int({ min: 1, max: 5 }), 'day').format('YYYY-MM-DD HH:mm:ss');
      const dedupeKey = `${txnDatetime}_${partialAmount}_${charge.parentName}_${++txnSeq}`;
      const txn = await db.run(
        'INSERT INTO payment_txn (txn_datetime, depositor_name, amount, memo, source_file, dedupe_key, match_status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [txnDatetime, charge.parentName, partialAmount, '교재비 일부', SOURCE_FILE, dedupeKey, 'matched', faker.helpers.arrayElement(adminIds), txnDatetime]
      );
      await db.run(
        'INSERT INTO charge_payment_match (charge_id, payment_txn_id, matched_amount, match_type, matched_by, matched_at) VALUES (?, ?, ?, ?, ?, ?)',
        [charge.id, txn.insertId, partialAmount, 'manual', faker.helpers.arrayElement(adminIds), txnDatetime]
      );
    }
  }

  // 매칭 안 된 미확인 입금 8건
  for (let i = 0; i < 8; i++) {
    const txnDatetime = today.subtract(faker.number.int({ min: 0, max: 14 }), 'day').format('YYYY-MM-DD HH:mm:ss');
    const randomName = randomKoreanName();
    const amount = faker.helpers.arrayElement([14000, 15000, 16000, 17500, 29000, 31500]);
    const dedupeKey = `${txnDatetime}_${amount}_${randomName}_${++txnSeq}`;
    await db.run(
      'INSERT INTO payment_txn (txn_datetime, depositor_name, amount, memo, source_file, dedupe_key, match_status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [txnDatetime, randomName, amount, faker.datatype.boolean() ? '교재비' : null, SOURCE_FILE, dedupeKey, 'unmatched', faker.helpers.arrayElement(adminIds), txnDatetime]
    );
  }
  console.log('✓ 입금 거래내역 생성');

  // ============================================================
  // 7. SMS 발송 로그
  // ============================================================
  let smsCount = 0;
  for (const charge of charges) {
    const phone = activeStudents.find(s => s.id === charge.studentId)?.parentName;
    const chargeMsg = `[EduBill] ${charge.studentName} 학생 교재비 안내\n금액: ${charge.totalAmount.toLocaleString()}원\n입금계좌: ${ACCOUNT_INFO}\n입금기한: ${charge.dueDate.format('YYYY-MM-DD')}`;
    const success = faker.datatype.boolean({ probability: 0.95 });
    await db.run(
      'INSERT INTO sms_log (charge_id, student_id, template_type, recipient_phone, message_content, send_status, fail_reason, sent_by, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [charge.id, charge.studentId, 'charge_notice', phone, chargeMsg, success ? 'success' : 'failed', success ? null : '번호 오류', faker.helpers.arrayElement(adminIds), dayjs(charge.createdAt).format('YYYY-MM-DD HH:mm:ss')]
    );
    smsCount++;

    if (charge.status === 'overdue' && faker.datatype.boolean({ probability: 0.7 })) {
      const overdueMsg = `[EduBill] ${charge.studentName} 학생 교재비 미납 안내\n금액: ${charge.totalAmount.toLocaleString()}원\n입금기한이 지났습니다.\n입금계좌: ${ACCOUNT_INFO}`;
      const s2 = faker.datatype.boolean({ probability: 0.95 });
      await db.run(
        'INSERT INTO sms_log (charge_id, student_id, template_type, recipient_phone, message_content, send_status, fail_reason, sent_by, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [charge.id, charge.studentId, 'overdue_notice', phone, overdueMsg, s2 ? 'success' : 'failed', s2 ? null : 'API 응답 시간초과', faker.helpers.arrayElement(adminIds), charge.dueDate.add(1, 'day').format('YYYY-MM-DD HH:mm:ss')]
      );
      smsCount++;
    }
  }
  console.log(`✓ SMS 발송 로그 ${smsCount}건 생성`);

  console.log('\n========== 시딩 완료 ==========');
  console.log('원장 - username: director / password: director123');
  console.log('직원 - username: staff1   / password: staff123');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
