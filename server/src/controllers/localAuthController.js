const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const setAuthCookie = require('../utils/setAuthCookie');
const sanitizeUser = require('../utils/sanitizeUser');
const jwt = require('jsonwebtoken');
const sendEmail = require('../utils/sendEmail');
require('dotenv').config();
const crypto = require('crypto');

const User = mongoose.model('User');

exports.signup = async (req, res) => {
  try {
    const { fullName, email, password, role } = req.body;
    if (!fullName || !email || !password || !role) {
      return res.status(404).json({
        error: 'All fields are required',
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Invalid email format',
      });
    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(409).json({
        message: 'User already exist',
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await new User({
      fullName,
      password: hashedPassword,
      email,
      role,
    }).save();

    // Create a JWT token for the newly registered user
    // Send the JWT token as an HTTP-only cookie
    setAuthCookie(res, newUser._id);

    // Destructure the user object to remove sensitive or unnecessary fields before sending to the client
    const safeToSendUser = sanitizeUser(newUser._doc);
    return res.status(201).json({
      message: 'User successfully registered',
      user: safeToSendUser,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;

  //Basic validation
  if (!email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  try {
    const existingUser = await User.findOne({ email });
    // If there is no existing user, do not log in
    if (!existingUser) {
      return res
        .status(401)
        .json({ error: 'User does not exist! Create an account to continue' });
    }

    if (existingUser) {
      // compare password to allow login if there is a user
      const comparePassword = bcrypt.compareSync(
        password,
        existingUser.password
      );

      // if passwords do not match, send error ,msg
      if (!comparePassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      setAuthCookie(res, existingUser._id);

      // Destructure the user object to remove sensitive or unnecessary fields before sending to the client
      const safeToSendUser = sanitizeUser(existingUser._doc);

      return res.status(200).json({
        message: 'User successfully logged in',
        user: safeToSendUser,
      });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.logout = async (_, res) => {
  try {
    res.clearCookie('token', {
      httpOnly: true,
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
    });
    return res.status(200).json({ message: 'Logged out successful' });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.linkAccount = async (req, res) => {
  const { token, password } = req.body;
  if (!password) {
    return res.status(404).json({ error: 'Password is required' });
  }

  try {
    // retrieve the user stored from the token and decode it
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { userEmail, googleID } = payload;

    const existingUser = await User.findOne({ email: userEmail });
    if (!existingUser) {
      return res.status(404).json({ error: 'User does not exist' });
    }

    const comparePassword = bcrypt.compareSync(password, existingUser.password);

    if (!comparePassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // add google ID to link account that initially signed in with email and password
    existingUser.googleID = googleID;
    await existingUser.save();

    setAuthCookie(res, googleID);
    return res.status(200).json({ message: 'Account linked successfully' });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const existingUser = await User.findOne({ email });
    if (!existingUser) {
      return res.status(401).json({ error: 'User does not exist' });
    }

    // if there is a user trying to reset password, go ahead and generate a token

    const token = crypto.randomBytes(32).toString('hex');

    //save token to db
    existingUser.resetPasswordToken = token;
    existingUser.resetPasswordExpires = new Date(Date.now() + 3600000); // token expires in 1hr
    await existingUser.save();

    // Send email with token
    const resetLink = `${process.env.CLIENT_URL}/reset-password?token=${token}&email=${email}`;

    const html = `
    <h3>Password Reset Request</h3>
    <p>Click the link below to reset your password:</p>
    <a href="${resetLink}">${resetLink}</a>
    <p>This link expires in 1 hour.</p>
  `;
    try {
      await sendEmail(email, 'Password Reset', html);
      return res
        .status(200)
        .json({ message: 'Reset link sent to your email.' });
    } catch (error) {
      console.error('Email send error:', error);
      return res.status(500).json({ error: 'Failed to send reset email' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.resetPassword = async (req, res) => {
  const { token, email, newPassword } = req.body;

  try {
    // fetch the user if the token is still valid
    const existingUser = await User.findOne({
      email,
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });
    if (!existingUser) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    existingUser.password = hashedPassword; //reset password
    existingUser.resetPasswordToken = undefined; // clear token
    existingUser.resetPasswordExpires = undefined;
    await existingUser.save();

    res.status(200).json({ message: 'Password reset successful' });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};
