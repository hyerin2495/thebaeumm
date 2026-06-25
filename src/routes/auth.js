const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.adminId) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  const admin = db.prepare(
    'SELECT * FROM admin_user WHERE username = ? AND is_active = 1'
  ).get(username);

  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.render('login', { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  req.session.adminId = admin.id;
  req.session.adminName = admin.display_name;
  req.session.adminRole = admin.role;

  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
