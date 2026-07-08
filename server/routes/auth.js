const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const supabase = require('../config/supabase');
require('dotenv').config();

const router = express.Router();

// ── Mailer (reuses your existing Brevo SMTP env vars) ──
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://api.bullionalgosystem.com/auth/google/callback'
},
async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    const name = profile.displayName;
    const google_id = profile.id;
    const avatar = profile.photos[0]?.value || null;

    // Check if user exists by google_id first
    let { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('google_id', google_id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Fetch error:', JSON.stringify(fetchError));
      return done(fetchError, null);
    }

    if (existingUser) {
      await supabase
        .from('users')
        .update({ avatar })
        .eq('google_id', google_id);

      return done(null, { ...existingUser, avatar });
    }

    // No google_id match — check if an email/password account already
    // exists with this email, and link the Google login to it instead
    // of creating a duplicate account.
    let { data: emailUser, error: emailFetchError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (emailFetchError && emailFetchError.code !== 'PGRST116') {
      console.error('Email fetch error:', JSON.stringify(emailFetchError));
      return done(emailFetchError, null);
    }

    if (emailUser) {
      const { data: linkedUser, error: linkError } = await supabase
        .from('users')
        .update({ google_id, avatar })
        .eq('id', emailUser.id)
        .select()
        .single();

      if (linkError) {
        console.error('Account link error:', JSON.stringify(linkError));
        return done(linkError, null);
      }

      return done(null, linkedUser);
    }

    // Brand new user — insert
    let { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ email, name, google_id, role: 'user', avatar }])
      .select()
      .single();

    if (insertError) {
      console.error('Insert error:', JSON.stringify(insertError));
      return done(insertError, null);
    }

    return done(null, newUser);

  } catch (err) {
    console.error('Google auth error:', JSON.stringify(err));
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error('Deserialize error:', JSON.stringify(error));
    return done(error, null);
  }

  done(null, user);
});

router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: 'https://bullionalgosystem.com' }),
  (req, res) => {
    const redirectTo = req.session.returnTo || 'https://bullionalgosystem.com/userdashboard.html';
    delete req.session.returnTo;
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(redirectTo);
    });
  }
);

router.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('https://bullionalgosystem.com');
  });
});

router.get('/me', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ loggedIn: true, user: req.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ─────────────────────────────────────────────
//  POST /auth/signup
//  Email + password + name + phone
// ─────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const { data: existing } = await supabase
      .from('users')
      .select('id, password_hash, google_id')
      .eq('email', email)
      .single();

    if (existing) {
      if (existing.password_hash) {
        return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
      }
      // Existing Google-only account with this email — don't silently
      // overwrite; ask them to log in with Google instead.
      if (existing.google_id) {
        return res.status(400).json({
          error: 'This email is already linked to a Google account. Please continue with Google.',
        });
      }
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ name, email, phone, password_hash, role: 'user' }])
      .select()
      .single();

    if (insertError) {
      console.error('[Signup] Insert error:', insertError);
      return res.status(500).json({ error: 'Could not create account. Please try again.' });
    }

    req.login(newUser, (err) => {
      if (err) {
        console.error('[Signup] Login after signup error:', err);
        return res.status(500).json({ error: 'Account created, but login failed. Please log in manually.' });
      }
      req.session.save(() => {
        res.json({ success: true, user: newUser });
      });
    });

  } catch (err) {
    console.error('[Signup] Error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  POST /auth/login
//  Email + password
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      // No account at all for this email — frontend should redirect to signup
      return res.status(404).json({ error: 'no_account', message: 'No account found with this email.' });
    }

    if (!user.password_hash) {
      // Account exists but was created via Google only
      return res.status(400).json({
        error: 'google_only',
        message: 'This account uses Google sign-in. Please continue with Google.',
      });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'invalid_password', message: 'Incorrect password.' });
    }

    req.login(user, (err) => {
      if (err) {
        console.error('[Login] req.login error:', err);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
      }
      req.session.save(() => {
        res.json({ success: true, user });
      });
    });

  } catch (err) {
    console.error('[Login] Error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  POST /auth/forgot-password
//  Sends reset link if the email exists (never reveals if it doesn't)
// ─────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { data: user } = await supabase
      .from('users')
      .select('id, name, password_hash')
      .eq('email', email)
      .single();

    // Always respond the same way whether or not the account exists,
    // to avoid leaking which emails are registered.
    const genericResponse = {
      success: true,
      message: 'If an account with that email exists, a reset link has been sent.',
    };

    if (!user || !user.password_hash) {
      return res.json(genericResponse);
    }

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires      = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await supabase
      .from('users')
      .update({ reset_token: hashedToken, reset_token_expires: expires })
      .eq('id', user.id);

    const resetUrl = `https://bullionalgosystem.com/reset-password.html?token=${rawToken}`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'Reset your Bullion Algo System password',
      html: `
        <div style="font-family: 'Outfit', sans-serif; background:#080B10; color:#E8E2D5; padding:32px;">
          <h2 style="color:#C9A84C; font-weight:400;">Reset your password</h2>
          <p>Hi ${user.name || 'there'}, click the link below to reset your Bullion Algo System password. This link expires in 1 hour.</p>
          <p><a href="${resetUrl}" style="color:#C9A84C;">${resetUrl}</a></p>
          <p style="color:#8A8275; font-size:0.85rem;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    res.json(genericResponse);

  } catch (err) {
    console.error('[Forgot Password] Error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  POST /auth/reset-password
//  Takes the raw token from the emailed link + new password
// ─────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const { data: user } = await supabase
      .from('users')
      .select('id, reset_token_expires')
      .eq('reset_token', hashedToken)
      .single();

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }
    if (new Date(user.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    await supabase
      .from('users')
      .update({ password_hash, reset_token: null, reset_token_expires: null })
      .eq('id', user.id);

    res.json({ success: true, message: 'Password updated. You can now log in.' });

  } catch (err) {
    console.error('[Reset Password] Error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;