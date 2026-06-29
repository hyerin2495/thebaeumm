CREATE TABLE IF NOT EXISTS admin_user (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'staff',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS student (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  school_name VARCHAR(100),
  grade VARCHAR(10),
  class_name VARCHAR(50),
  student_phone VARCHAR(20),
  parent_name VARCHAR(100),
  parent_phone VARCHAR(20) NOT NULL,
  memo TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT NOW(),
  updated_at DATETIME NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS book (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  subject VARCHAR(50),
  publisher VARCHAR(100),
  price INT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT NOW(),
  updated_at DATETIME NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_template (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_setting (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT,
  updated_at DATETIME NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS charge (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  total_amount INT NOT NULL,
  due_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
  created_by INT,
  created_at DATETIME NOT NULL DEFAULT NOW(),
  updated_at DATETIME NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS charge_item (
  id INT AUTO_INCREMENT PRIMARY KEY,
  charge_id INT NOT NULL,
  book_id INT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price INT NOT NULL,
  line_amount INT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_txn (
  id INT AUTO_INCREMENT PRIMARY KEY,
  txn_datetime DATETIME NOT NULL,
  depositor_name VARCHAR(100) NOT NULL,
  amount INT NOT NULL,
  memo TEXT,
  source_file VARCHAR(255),
  dedupe_key VARCHAR(255) NOT NULL UNIQUE,
  match_status VARCHAR(20) NOT NULL DEFAULT 'unmatched',
  uploaded_by INT,
  created_at DATETIME NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS charge_payment_match (
  id INT AUTO_INCREMENT PRIMARY KEY,
  charge_id INT NOT NULL,
  payment_txn_id INT NOT NULL,
  matched_amount INT NOT NULL,
  match_type VARCHAR(10) NOT NULL DEFAULT 'auto',
  matched_by INT,
  matched_at DATETIME NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  charge_id INT,
  student_id INT NOT NULL,
  template_type VARCHAR(50) NOT NULL,
  recipient_phone VARCHAR(20) NOT NULL,
  message_content TEXT NOT NULL,
  send_status VARCHAR(10) NOT NULL DEFAULT 'success',
  fail_reason TEXT,
  sent_by INT,
  sent_at DATETIME NOT NULL DEFAULT NOW()
);
