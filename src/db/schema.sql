-- ============================================================
-- 더배움 영수학원 교재비 납부 + SMS 알림 시스템
-- DB 스키마 (SQLite)
-- 참고: DIM_SCHOOL / 학생-학교 연결 테이블은 사용하지 않음
--       (교재는 관리자가 직접 검색해서 선택하는 단순 방식)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ----------------------------
-- 관리자 계정
-- ----------------------------
CREATE TABLE IF NOT EXISTS admin_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',   -- 'director' | 'staff'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER NOT NULL DEFAULT 1
);

-- ----------------------------
-- 학생 (학부모 연락처 포함)
-- ----------------------------
CREATE TABLE IF NOT EXISTS student (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  school_name TEXT,                     -- 자유 입력 텍스트 (차원테이블 아님)
  grade TEXT,                           -- 예: '중1', '고2'
  student_phone TEXT,
  parent_name TEXT,
  parent_phone TEXT NOT NULL,           -- SMS 수신 대상 (필수)
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'inactive' (소프트 삭제)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------
-- 교재 (단순 목록, 관리자가 직접 검색/선택)
-- ----------------------------
CREATE TABLE IF NOT EXISTS book (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT,                         -- 과목: 영어/수학 등
  publisher TEXT,
  price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'inactive'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------
-- SMS 템플릿
-- ----------------------------
CREATE TABLE IF NOT EXISTS sms_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                   -- 'charge_notice' | 'overdue_notice'
  name TEXT NOT NULL,
  content TEXT NOT NULL,                -- 변수: {학생명}{교재명}{금액}{계좌}{기한}
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------
-- 청구 (학생 + 교재 묶음을 1건의 청구로)
-- ----------------------------
CREATE TABLE IF NOT EXISTS charge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES student(id),
  total_amount INTEGER NOT NULL,        -- charge_item 합계 (비정규화 캐시)
  due_date TEXT NOT NULL,               -- 입금기한 (YYYY-MM-DD)
  status TEXT NOT NULL DEFAULT 'unpaid', -- 'unpaid' | 'partial' | 'paid' | 'overdue' | 'canceled'
  created_by INTEGER REFERENCES admin_user(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 청구에 포함된 교재 상세 (청구 1건 : 교재 N개)
CREATE TABLE IF NOT EXISTS charge_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_id INTEGER NOT NULL REFERENCES charge(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES book(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL,          -- 청구 시점 단가 (교재 단가 변경 영향 안받도록 스냅샷)
  line_amount INTEGER NOT NULL          -- quantity * unit_price
);

-- ----------------------------
-- 입금 거래내역 (은행 파일 업로드 결과)
-- ----------------------------
CREATE TABLE IF NOT EXISTS payment_txn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_datetime TEXT NOT NULL,           -- 거래일시
  depositor_name TEXT NOT NULL,         -- 입금자명
  amount INTEGER NOT NULL,              -- 입금금액
  memo TEXT,                            -- 거래메모 (선택)
  source_file TEXT,                     -- 업로드된 원본 파일명
  dedupe_key TEXT NOT NULL UNIQUE,      -- 거래일시+금액+입금자명 조합 (중복방지)
  match_status TEXT NOT NULL DEFAULT 'unmatched', -- 'unmatched' | 'matched' | 'ignored'
  uploaded_by INTEGER REFERENCES admin_user(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 청구-입금 매칭 브릿지 테이블 (부분납/다대다 매칭 지원)
CREATE TABLE IF NOT EXISTS charge_payment_match (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_id INTEGER NOT NULL REFERENCES charge(id),
  payment_txn_id INTEGER NOT NULL REFERENCES payment_txn(id),
  matched_amount INTEGER NOT NULL,      -- 이 매칭으로 처리된 금액
  match_type TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'manual'
  matched_by INTEGER REFERENCES admin_user(id),
  matched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------
-- SMS 발송 로그
-- ----------------------------
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_id INTEGER REFERENCES charge(id),
  student_id INTEGER NOT NULL REFERENCES student(id),
  template_type TEXT NOT NULL,          -- 'charge_notice' | 'overdue_notice'
  recipient_phone TEXT NOT NULL,
  message_content TEXT NOT NULL,        -- 변수 치환된 실제 발송 내용
  send_status TEXT NOT NULL DEFAULT 'success', -- 'success' | 'failed'
  fail_reason TEXT,
  sent_by INTEGER REFERENCES admin_user(id),
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------
-- 앱 설정 (계좌정보, SMS API 키 등 키-값 저장)
-- ----------------------------
CREATE TABLE IF NOT EXISTS app_setting (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------
-- 인덱스
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_student_status ON student(status);
CREATE INDEX IF NOT EXISTS idx_student_name ON student(name);
CREATE INDEX IF NOT EXISTS idx_book_status ON book(status);
CREATE INDEX IF NOT EXISTS idx_charge_student ON charge(student_id);
CREATE INDEX IF NOT EXISTS idx_charge_status ON charge(status);
CREATE INDEX IF NOT EXISTS idx_charge_due_date ON charge(due_date);
CREATE INDEX IF NOT EXISTS idx_charge_item_charge ON charge_item(charge_id);
CREATE INDEX IF NOT EXISTS idx_payment_txn_status ON payment_txn(match_status);
CREATE INDEX IF NOT EXISTS idx_cpm_charge ON charge_payment_match(charge_id);
CREATE INDEX IF NOT EXISTS idx_cpm_txn ON charge_payment_match(payment_txn_id);
CREATE INDEX IF NOT EXISTS idx_sms_log_charge ON sms_log(charge_id);
CREATE INDEX IF NOT EXISTS idx_sms_log_student ON sms_log(student_id);
