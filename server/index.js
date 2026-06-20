const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const mt5Routes = require('./routes/mt5');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const newsletterRoutes = require('./routes/newsletter');
const app = express();

app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());
const path = require('path');
app.use(express.static('C:/Users/DARTONX/Downloads/TRADING BOT/frontendwork - Copy'));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

app.use('/auth', authRoutes);
app.use('/mt5', mt5Routes);
app.use('/dashboard', dashboardRoutes);
app.use('/admin', adminRoutes);
app.use('/newsletter', newsletterRoutes);

app.get('/api/ping', (req, res) => {
  res.json({ message: 'Server is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});