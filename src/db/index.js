require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 5,
  timezone: '+09:00',
  dateStrings: true,
});

const db = {
  async get(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows[0] || null;
  },
  async all(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
  },
  async run(sql, params = []) {
    const [result] = await pool.query(sql, params);
    return { insertId: result.insertId, affectedRows: result.affectedRows };
  },
  async transaction(fn) {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      const result = await fn({
        async get(sql, params = []) {
          const [rows] = await conn.query(sql, params);
          return rows[0] || null;
        },
        async all(sql, params = []) {
          const [rows] = await conn.query(sql, params);
          return rows;
        },
        async run(sql, params = []) {
          const [result] = await conn.query(sql, params);
          return { insertId: result.insertId, affectedRows: result.affectedRows };
        },
      });
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
  pool,
};

module.exports = db;
