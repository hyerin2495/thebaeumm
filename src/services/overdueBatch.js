const db = require('../db');

async function detectOverdue() {
  const result = await db.run(`
    UPDATE charge
    SET status = 'overdue', updated_at = NOW()
    WHERE status IN ('unpaid', 'partial')
      AND due_date < CURDATE()
  `);
  return result.affectedRows;
}

module.exports = { detectOverdue };
