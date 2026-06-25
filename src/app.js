const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const studentRoutes = require('./routes/students');
const bookRoutes = require('./routes/books');
const chargeRoutes = require('./routes/charges');
const paymentRoutes = require('./routes/payments');
const overdueRoutes = require('./routes/overdue');
const smsLogRoutes = require('./routes/smsLogs');
const settingsRoutes = require('./routes/settings');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  secret: 'daebaeum-dev-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8시간
}));

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/', studentRoutes);
app.use('/', bookRoutes);
app.use('/', chargeRoutes);
app.use('/', paymentRoutes);
app.use('/', overdueRoutes);
app.use('/', smsLogRoutes);
app.use('/', settingsRoutes);

app.use((req, res) => {
  res.status(404).send('페이지를 찾을 수 없습니다.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
