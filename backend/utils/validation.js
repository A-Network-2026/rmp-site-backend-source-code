function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isValidPassword(password, minLength = 8) {
  return String(password || '').length >= minLength;
}

function isValidOtp(otp) {
  return /^\d{6}$/.test(String(otp || '').trim());
}

function sanitizeText(value, maxLength = 255) {
  return String(value || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLength);
}

module.exports = {
  isValidEmail,
  isValidPassword,
  isValidOtp,
  sanitizeText,
};
