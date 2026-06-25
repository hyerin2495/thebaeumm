const db = require('../db');

/**
 * 입금기한이 지난 unpaid/partial 청구를 overdue로 전환.
 * 기획서 3.4: 매일 1회 배치로 처리하는 게 정석이지만,
 * 데모 환경에서는 미납 관리 화면 진입 시마다 실행해서 배치를 흉내낸다.
 *
 * @returns {number} 전환된 건수
 */
function detectOverdue() {
  const result = db.prepare(`
    UPDATE charge
    SET status = 'overdue', updated_at = datetime('now')
    WHERE status IN ('unpaid', 'partial')
      AND date(due_date) < date('now')
  `).run();

  return result.changes;
}

module.exports = { detectOverdue };
