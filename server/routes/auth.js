const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../config/supabase');
require('dotenv').config();

const router = express.Router();

async function sendEmail({ to, subject, html, from = process.env.MAIL_FROM_AUTH }) {
  return axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender:  { email: from, name: 'Bullion Algo System' },
      to:      [{ email: to }],
      subject,
      htmlContent: html,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
    }
  );
}

async function sendWelcomeEmail(user) {
  if (!user?.email) return;

  await sendEmail({
    to: user.email,
    subject: 'Welcome to Bullion Algo System',
    html: `
      <div style="font-family: 'Outfit', sans-serif; background:#080B10; color:#E8E2D5; padding:32px;">
        <h2 style="color:#C9A84C; font-weight:400;">Welcome, ${user.name || 'there'}.</h2>
        <p>Your Bullion Algo System account has been created.</p>
        <p>Next step — connect your MT5 account from your dashboard so we can attach the trading algorithm and start powering your live balance, equity, and trade history view.</p>
        <p><a href="https://bullionalgosystem.com/userdashboard.html" style="color:#C9A84C;">Go to your dashboard →</a></p>
        <p style="color:#8A8275; font-size:0.85rem;">If you didn't create this account, you can safely ignore this email.</p>
      </div>
    `,
  });
}

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

    let { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ email, name, google_id, role: 'user', avatar }])
      .select()
      .single();

    if (insertError) {
      console.error('Insert error:', JSON.stringify(insertError));
      return done(insertError, null);
    }

    sendWelcomeEmail(newUser).catch(mailErr =>
      console.error('[Google Signup] Welcome email failed:', mailErr.response?.data || mailErr.message)
    );

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

    sendWelcomeEmail(newUser).catch(mailErr =>
      console.error('[Signup] Welcome email failed:', mailErr.response?.data || mailErr.message)
    );

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
      return res.status(404).json({ error: 'no_account', message: 'No account found with this email.' });
    }

    if (!user.password_hash) {
      return res.status(400).json({
        error: 'google_only',
        message: 'This account uses Google sign-in. Please continue with Google.',
      });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'invalid_password', message: 'Incorrect password.' });
    }

    if (user.role === 'admin') {
      const rawOtp    = Math.floor(100000 + Math.random() * 900000).toString();
      const hashedOtp = crypto.createHash('sha256').update(rawOtp).digest('hex');
      const expires   = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { error: otpError } = await supabase
        .from('users')
        .update({ otp_hash: hashedOtp, otp_expires: expires })
        .eq('id', user.id);

      if (otpError) {
        console.error('[Login] Failed to store admin OTP:', otpError);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
      }

      try {
        await sendEmail({
          to: user.email,
          subject: 'Your Bullion Algo System admin verification code',
          html: `
            <div style="font-family: 'Outfit', sans-serif; background:#080B10; color:#E8E2D5; padding:32px;">
              <h2 style="color:#C9A84C; font-weight:400;">Admin verification code</h2>
              <p>Hi ${user.name || 'there'}, use the code below to finish signing in. This code expires in 10 minutes.</p>
              <p style="font-size:2rem; letter-spacing:0.3em; color:#C9A84C; font-weight:600;">${rawOtp}</p>
              <p style="color:#8A8275; font-size:0.85rem;">If you didn't try to log in, you can safely ignore this email — your account is still protected by your password.</p>
            </div>
          `,
        });
      } catch (mailErr) {
        console.error('[Login] Admin OTP email send failed:', mailErr.response?.data || mailErr.message);
        return res.status(500).json({ error: 'Could not send verification code. Please try again.' });
      }

      return res.json({
        success: false,
        requiresOtp: true,
        email: user.email,
        message: 'Enter the verification code sent to your email.',
      });
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


router.post('/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required.' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    if (!user.otp_hash || !user.otp_expires) {
      return res.status(400).json({ error: 'No verification code pending. Please log in again.' });
    }

    if (new Date(user.otp_expires) < new Date()) {
      await supabase.from('users').update({ otp_hash: null, otp_expires: null }).eq('id', user.id);
      return res.status(400).json({ error: 'This code has expired. Please log in again.' });
    }

    const hashedInput = crypto.createHash('sha256').update(code.trim()).digest('hex');
    if (hashedInput !== user.otp_hash) {
      return res.status(401).json({ error: 'Incorrect code.' });
    }

    await supabase.from('users').update({ otp_hash: null, otp_expires: null }).eq('id', user.id);

    req.login(user, (err) => {
      if (err) {
        console.error('[Verify OTP] req.login error:', err);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
      }
      req.session.save(() => {
        res.json({ success: true, user });
      });
    });

  } catch (err) {
    console.error('[Verify OTP] Error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});


router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { data: user } = await supabase
      .from('users')
      .select('id, name, password_hash')
      .eq('email', email)
      .single();

    const genericResponse = {
      success: true,
      message: 'If an account with that email exists, a reset link has been sent.',
    };

    if (!user || !user.password_hash) {
      return res.json(genericResponse);
    }

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires     = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await supabase
      .from('users')
      .update({ reset_token: hashedToken, reset_token_expires: expires })
      .eq('id', user.id);

    const resetUrl = `https://bullionalgosystem.com/reset-password.html?token=${rawToken}`;

    try {
      await sendEmail({
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
    } catch (mailErr) {
      console.error('[Forgot Password] Brevo send error:', mailErr.response?.data || mailErr.message);
    }

    res.json(genericResponse);

  } catch (err) {
    console.error('[Forgot Password] Error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});


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