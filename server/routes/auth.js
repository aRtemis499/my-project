const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const supabase = require('../config/supabase');
require('dotenv').config();

const router = express.Router();

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

    // Check if user exists
    let { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('google_id', google_id)
      .single();

    // PGRST116 = no rows found, that's fine for new users
    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Fetch error:', JSON.stringify(fetchError));
      return done(fetchError, null);
    }

    if (existingUser) {
      // Update avatar in case it changed
      await supabase
        .from('users')
        .update({ avatar })
        .eq('google_id', google_id);

      return done(null, { ...existingUser, avatar });
    }

    // New user — insert them
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

module.exports = router;