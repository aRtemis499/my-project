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
const paymentRoutes = require('./routes/payments');

const app = express();

// Must be before express.json() middleware for the webhook route
app.use('/payments/webhook', express.raw({ type: 'application/json' }));

// Then your normal JSON middleware for everything else
app.use(express.json());

app.set('trust proxy', 1);

app.use(cors({
  origin: ['https://bullionalgosystem.com', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

app.use(passport.initialize());
app.use(passport.session());

app.use('/auth', authRoutes);
app.use('/mt5', mt5Routes);
app.use('/dashboard', dashboardRoutes);
app.use('/admin', adminRoutes);
app.use('/newsletter', newsletterRoutes);
app.use('/payments', paymentRoutes);  

app.get('/api/ping', (req, res) => {
  res.json({ message: 'Server is running!' });
});

require('./jobs/subscriptionChecker');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});