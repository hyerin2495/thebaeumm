const { faker } = require('@faker-js/faker');
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const db = require('./index.js');

faker.seed(2026); // 재현 가능한 랜덤

// ============================================================
// 0. 기존 데이터 초기화 (재실행 가능하도록)
// ============================================================
const tables = [
  'sms_log', 'charge_payment_match', 'payment_txn',
  'charge_item', 'charge', 'sms_template', 'book', 'student', 'admin_user'
];
for (const t of tables) {
  db.exec(`DELETE FROM ${t};`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name='${t}';`);
}

// ============================================================
// 1. 관리자 계정
// ============================================================
const insertAdmin = db.prepare(`
  INSERT INTO admin_user (username, password_hash, display_name, role)
  VALUES (?, ?, ?, ?)
`);

const directorHash = bcrypt.hashSync('director123', 10);
const staffHash = bcrypt.hashSync('staff123', 10);

insertAdmin.run('director', directorHash, '김원장', 'director');
insertAdmin.run('staff1', staffHash, '이직원', 'staff');

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
  const last = faker.helpers.arrayElement(koreanLastNames);
  const first = faker.helpers.arrayElement(koreanFirstNames);
  return last + first;
}

function randomPhone() {
  const mid = faker.string.numeric(4);
  const end = faker.string.numeric(4);
  return `010-${mid}-${end}`;
}

const insertStudent = db.prepare(`
  INSERT INTO student (name, school_name, grade, student_phone, parent_name, parent_phone, memo, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const STUDENT_COUNT = 70;
const studentIds = [];

for (let i = 0; i < STUDENT_COUNT; i++) {
  const isHigh = faker.datatype.boolean({ probability: 0.45 });
  const school = isHigh
    ? faker.helpers.arrayElement(schools.slice(5))
    : faker.helpers.arrayElement(schools.slice(0, 5));
  const grade = isHigh
    ? faker.helpers.arrayElement(highGrades)
    : faker.helpers.arrayElement(middleGrades);

  const studentName = randomKoreanName();
  const parentLastName = studentName[0]; // 보통 같은 성씨
  const parentName = parentLastName + faker.helpers.arrayElement(['민', '영', '수', '진', '경']) + faker.helpers.arrayElement(['수', '희', '호', '자', '란']);

  // 95% 정도는 정상 등록(active), 일부는 퇴원 처리(inactive)로 소프트삭제 케이스 만들기
  const status = faker.datatype.boolean({ probability: 0.93 }) ? 'active' : 'inactive';

  const createdAt = dayjs().subtract(faker.number.int({ min: 10, max: 240 }), 'day').format('YYYY-MM-DD HH:mm:ss');

  const result = insertStudent.run(
    studentName,
    school,
    grade,
    faker.datatype.boolean({ probability: 0.6 }) ? randomPhone() : null,
    parentName,
    randomPhone(),
    faker.datatype.boolean({ probability: 0.15 }) ? '형제 동시 등록' : null,
    status,
    createdAt
  );
  studentIds.push({ id: result.lastInsertRowid, createdAt, status });
}

console.log(`✓ 학생 ${STUDENT_COUNT}명 생성`);

// ============================================================
// 3. 교재 18종 (영어 9 + 수학 9)
// ============================================================
const englishBooks = [
  { name: '능률 중학영어 1', price: 14000 },
  { name: '능률 중학영어 2', price: 14000 },
  { name: '능률 중학영어 3', price: 14500 },
  { name: '리딩튜터 입문', price: 16000 },
  { name: '리딩튜터 기본', price: 17000 },
  { name: '쎄듀 어휘끝 중등', price: 13000 },
  { name: '천일문 입문편', price: 18000 },
  { name: '고등영어 독해 기본', price: 15500 },
  { name: '수능특강 영어', price: 16500 },
];

const mathBooks = [
  { name: '개념원리 중학수학 1-1', price: 15000 },
  { name: '개념원리 중학수학 2-1', price: 15000 },
  { name: '개념원리 중학수학 3-1', price: 15500 },
  { name: '쎈 중등수학 1상', price: 16000 },
  { name: '쎈 중등수학 2상', price: 16000 },
  { name: '수학의 정석 (실력)', price: 19000 },
  { name: '高 수학 I', price: 17500 },
  { name: '高 수학 II', price: 17500 },
  { name: '수능특강 수학', price: 18500 },
];

const insertBook = db.prepare(`
  INSERT INTO book (name, subject, publisher, price, status)
  VALUES (?, ?, ?, ?, ?)
`);

const publishers = {
  english: ['능률교육', '쎄듀', 'NE능률', '비상교육'],
  math: ['개념원리수학연구소', '좋은책신사고', '성지출판', 'EBS'],
};

const bookIds = [];

for (const b of englishBooks) {
  const result = insertBook.run(b.name, '영어', faker.helpers.arrayElement(publishers.english), b.price, 'active');
  bookIds.push({ id: result.lastInsertRowid, name: b.name, price: b.price, subject: '영어' });
}
for (const b of mathBooks) {
  const result = insertBook.run(b.name, '수학', faker.helpers.arrayElement(publishers.math), b.price, 'active');
  bookIds.push({ id: result.lastInsertRowid, name: b.name, price: b.price, subject: '수학' });
}

console.log(`✓ 교재 ${bookIds.length}종 생성 (영어 ${englishBooks.length} / 수학 ${mathBooks.length})`);

// ============================================================
// 4. SMS 템플릿 2종
// ============================================================
const insertTemplate = db.prepare(`
  INSERT INTO sms_template (type, name, content, is_default)
  VALUES (?, ?, ?, ?)
`);

insertTemplate.run(
  'charge_notice',
  '교재비 안내 (기본)',
  '[더배움 영수학원] {학생명} 학생 교재비 안내\n교재: {교재명}\n금액: {금액}원\n입금계좌: {계좌}\n입금기한: {기한}\n문의: 학원 데스크',
  1
);

insertTemplate.run(
  'overdue_notice',
  '미납 안내 (기본)',
  '[더배움 영수학원] {학생명} 학생 교재비 미납 안내\n금액: {금액}원\n입금기한이 지났습니다. 빠른 입금 부탁드립니다.\n입금계좌: {계좌}\n문의: 학원 데스크',
  1
);

console.log('✓ SMS 템플릿 2종 생성');

// ============================================================
// 4-1. 앱 설정 기본값 (계좌정보, SMS API 키 placeholder)
// ============================================================
const insertSetting = db.prepare(`
  INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
`);
insertSetting.run('account_info', '농협 123-456-789012 (더배움영수학원)');
insertSetting.run('sms_api_provider', 'aligo');
insertSetting.run('sms_api_key', '');
insertSetting.run('sms_sender_number', '');

console.log('✓ 앱 설정 기본값 생성 (계좌정보, SMS API 설정)');

// ============================================================
// 5. 청구 + 청구상세 (학생당 1~3건)
//    상태 분포: 완납(paid) 50% / 미납-기한초과(overdue) 25% / 미수금-기한이내(unpaid) 15% / 부분납(partial) 10%
// ============================================================
const ACCOUNT_INFO = '농협 123-456-789012 (더배움영수학원)';

const insertCharge = db.prepare(`
  INSERT INTO charge (student_id, total_amount, due_date, status, created_by, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertChargeItem = db.prepare(`
  INSERT INTO charge_item (charge_id, book_id, quantity, unit_price, line_amount)
  VALUES (?, ?, ?, ?, ?)
`);

const adminIds = [1, 2];
const charges = []; // {id, studentId, totalAmount, dueDate, status, createdAt}

const activeStudents = studentIds.filter(s => s.status === 'active');

for (const student of activeStudents) {
  const chargeCount = faker.number.int({ min: 1, max: 3 });

  for (let c = 0; c < chargeCount; c++) {
    // 청구에 들어갈 교재 1~3종 랜덤 선택
    const itemCount = faker.number.int({ min: 1, max: 3 });
    const selectedBooks = faker.helpers.arrayElements(bookIds, itemCount);

    let totalAmount = 0;
    const items = selectedBooks.map(b => {
      const qty = 1;
      const lineAmount = b.price * qty;
      totalAmount += lineAmount;
      return { bookId: b.id, qty, unitPrice: b.price, lineAmount };
    });

    const today = dayjs();
    let createdAt = dayjs(student.createdAt).add(faker.number.int({ min: 5, max: 200 }), 'day');
    if (createdAt.isAfter(today)) {
      createdAt = today.subtract(faker.number.int({ min: 1, max: 60 }), 'day');
    }
    const dueDate = createdAt.add(7, 'day'); // 청구 후 7일 입금기한

    // 상태 결정
    const roll = faker.number.float({ min: 0, max: 1 });
    let status;
    if (roll < 0.50) status = 'paid';
    else if (roll < 0.75) status = 'overdue';
    else if (roll < 0.90) status = 'unpaid';
    else status = 'partial';

    // overdue/unpaid 구분: due_date를 과거/미래로 조정
    let finalDueDate;
    if (status === 'overdue') {
      finalDueDate = today.subtract(faker.number.int({ min: 1, max: 30 }), 'day');
    } else if (status === 'unpaid') {
      finalDueDate = today.add(faker.number.int({ min: 1, max: 10 }), 'day');
    } else {
      // paid, partial은 과거에 생성되어 이미 처리된 것으로 (확실히 과거 마감일)
      finalDueDate = createdAt.add(7, 'day');
      if (finalDueDate.isAfter(today.subtract(1, 'day'))) {
        finalDueDate = today.subtract(faker.number.int({ min: 2, max: 20 }), 'day');
      }
    }

    const chargeResult = insertCharge.run(
      student.id,
      totalAmount,
      finalDueDate.format('YYYY-MM-DD'),
      status,
      faker.helpers.arrayElement(adminIds),
      createdAt.format('YYYY-MM-DD HH:mm:ss'),
      createdAt.format('YYYY-MM-DD HH:mm:ss')
    );

    const chargeId = chargeResult.lastInsertRowid;

    for (const item of items) {
      insertChargeItem.run(chargeId, item.bookId, item.qty, item.unitPrice, item.lineAmount);
    }

    charges.push({
      id: chargeId,
      studentId: student.id,
      totalAmount,
      dueDate: finalDueDate,
      status,
      createdAt,
    });
  }
}

console.log(`✓ 청구 ${charges.length}건 생성 (학생 ${activeStudents.length}명 대상)`);

const statusCount = charges.reduce((acc, c) => {
  acc[c.status] = (acc[c.status] || 0) + 1;
  return acc;
}, {});
console.log('  └ 상태 분포:', JSON.stringify(statusCount));

// ============================================================
// 6. 입금 거래내역 (payment_txn) + 매칭 (charge_payment_match)
//    - paid 청구: 정확히 매칭되는 거래 1건 생성 + 매칭 처리
//    - partial 청구: 일부 금액만 입금된 거래 생성 + 부분 매칭
//    - 추가로 매칭 안 된(미확인) 거래 몇 건 생성
// ============================================================
const studentMap = new Map();
for (const s of studentIds) studentMap.set(s.id, s);

// 학생 이름 조회용
const allStudentRows = db.prepare('SELECT id, name, parent_name FROM student').all();
const studentNameMap = new Map(allStudentRows.map(s => [s.id, s]));

const insertTxn = db.prepare(`
  INSERT INTO payment_txn (txn_datetime, depositor_name, amount, memo, source_file, dedupe_key, match_status, uploaded_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertMatch = db.prepare(`
  INSERT INTO charge_payment_match (charge_id, payment_txn_id, matched_amount, match_type, matched_by, matched_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const updateChargeStatus = db.prepare(`UPDATE charge SET status = ?, updated_at = ? WHERE id = ?`);
const updateTxnStatus = db.prepare(`UPDATE payment_txn SET match_status = ? WHERE id = ?`);

let txnSeq = 0;
function dedupeKey(datetime, amount, depositor) {
  txnSeq++;
  return `${datetime}_${amount}_${depositor}_${txnSeq}`;
}

const SOURCE_FILE = 'nh_transactions_202606.xlsx';

for (const charge of charges) {
  const student = studentNameMap.get(charge.studentId);
  const depositorName = student.parent_name; // 보통 학부모 명의로 입금

  if (charge.status === 'paid') {
    const txnDateTime = dayjs(charge.createdAt).add(faker.number.int({ min: 1, max: 5 }), 'day').format('YYYY-MM-DD HH:mm:ss');
    const txnResult = insertTxn.run(
      txnDateTime,
      depositorName,
      charge.totalAmount,
      '교재비',
      SOURCE_FILE,
      dedupeKey(txnDateTime, charge.totalAmount, depositorName),
      'matched',
      faker.helpers.arrayElement(adminIds),
      txnDateTime
    );
    insertMatch.run(
      charge.id,
      txnResult.lastInsertRowid,
      charge.totalAmount,
      'auto',
      faker.helpers.arrayElement(adminIds),
      txnDateTime
    );
  } else if (charge.status === 'partial') {
    const partialAmount = Math.round(charge.totalAmount * faker.number.float({ min: 0.4, max: 0.7 }) / 100) * 100;
    const txnDateTime = dayjs(charge.createdAt).add(faker.number.int({ min: 1, max: 5 }), 'day').format('YYYY-MM-DD HH:mm:ss');
    const txnResult = insertTxn.run(
      txnDateTime,
      depositorName,
      partialAmount,
      '교재비 일부',
      SOURCE_FILE,
      dedupeKey(txnDateTime, partialAmount, depositorName),
      'matched',
      faker.helpers.arrayElement(adminIds),
      txnDateTime
    );
    insertMatch.run(
      charge.id,
      txnResult.lastInsertRowid,
      partialAmount,
      'manual',
      faker.helpers.arrayElement(adminIds),
      txnDateTime
    );
  }
  // overdue, unpaid는 입금 거래 없음 (의도적으로 비워둠 - 미납관리 화면 시연용)
}

// 매칭 안 된 미확인 입금 8건 추가 (입금했는데 학생 특정 안 된 케이스)
const unmatchedCount = 8;
for (let i = 0; i < unmatchedCount; i++) {
  const txnDateTime = dayjs().subtract(faker.number.int({ min: 0, max: 14 }), 'day').format('YYYY-MM-DD HH:mm:ss');
  const randomName = randomKoreanName();
  const amount = faker.helpers.arrayElement([14000, 15000, 16000, 17500, 29000, 31500]);
  insertTxn.run(
    txnDateTime,
    randomName,
    amount,
    faker.datatype.boolean() ? '교재비' : null,
    SOURCE_FILE,
    dedupeKey(txnDateTime, amount, randomName),
    'unmatched',
    faker.helpers.arrayElement(adminIds),
    txnDateTime
  );
}

const txnCountRow = db.prepare('SELECT COUNT(*) as cnt FROM payment_txn').get();
console.log(`✓ 입금 거래내역 ${txnCountRow.cnt}건 생성 (미확인 ${unmatchedCount}건 포함)`);

// ============================================================
// 7. SMS 발송 로그
//    - 모든 청구 생성 시 '교재비 안내' 발송 로그
//    - overdue 청구 중 일부는 '미납 안내' 발송 로그도 추가
// ============================================================
const insertSmsLog = db.prepare(`
  INSERT INTO sms_log (charge_id, student_id, template_type, recipient_phone, message_content, send_status, fail_reason, sent_by, sent_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const studentPhoneMap = new Map(
  db.prepare('SELECT id, parent_phone FROM student').all().map(s => [s.id, s.parent_phone])
);

let smsCount = 0;
for (const charge of charges) {
  const student = studentNameMap.get(charge.studentId);
  const phone = studentPhoneMap.get(charge.studentId);

  // 청구 안내 SMS (95% 성공)
  const chargeNoticeSuccess = faker.datatype.boolean({ probability: 0.95 });
  const chargeMsg = `[더배움 영수학원] ${student.name} 학생 교재비 안내\n금액: ${charge.totalAmount.toLocaleString()}원\n입금계좌: ${ACCOUNT_INFO}\n입금기한: ${charge.dueDate.format('YYYY-MM-DD')}`;

  insertSmsLog.run(
    charge.id,
    charge.studentId,
    'charge_notice',
    phone,
    chargeMsg,
    chargeNoticeSuccess ? 'success' : 'failed',
    chargeNoticeSuccess ? null : faker.helpers.arrayElement(['번호 오류', 'API 응답 시간초과', '수신거부 번호']),
    faker.helpers.arrayElement(adminIds),
    dayjs(charge.createdAt).format('YYYY-MM-DD HH:mm:ss')
  );
  smsCount++;

  // overdue 상태 청구 중 70%는 미납 안내도 발송됨
  if (charge.status === 'overdue' && faker.datatype.boolean({ probability: 0.7 })) {
    const overdueMsg = `[더배움 영수학원] ${student.name} 학생 교재비 미납 안내\n금액: ${charge.totalAmount.toLocaleString()}원\n입금기한이 지났습니다. 빠른 입금 부탁드립니다.\n입금계좌: ${ACCOUNT_INFO}`;
    const overdueSuccess = faker.datatype.boolean({ probability: 0.95 });
    const sentAt = dayjs(charge.dueDate).add(1, 'day').format('YYYY-MM-DD HH:mm:ss');

    insertSmsLog.run(
      charge.id,
      charge.studentId,
      'overdue_notice',
      phone,
      overdueMsg,
      overdueSuccess ? 'success' : 'failed',
      overdueSuccess ? null : faker.helpers.arrayElement(['번호 오류', 'API 응답 시간초과']),
      faker.helpers.arrayElement(adminIds),
      sentAt
    );
    smsCount++;
  }
}

console.log(`✓ SMS 발송 로그 ${smsCount}건 생성`);

// ============================================================
// 요약 출력
// ============================================================
console.log('\n========== 시딩 완료 ==========');
console.log(`학생: ${STUDENT_COUNT}명 (활성 ${activeStudents.length} / 비활성 ${STUDENT_COUNT - activeStudents.length})`);
console.log(`교재: ${bookIds.length}종`);
console.log(`청구: ${charges.length}건`);
console.log(`입금거래: ${txnCountRow.cnt}건`);
console.log(`SMS로그: ${smsCount}건`);
console.log('================================');
console.log('\n[관리자 로그인 정보]');
console.log('원장 - username: director / password: director123');
console.log('직원 - username: staff1   / password: staff123');
