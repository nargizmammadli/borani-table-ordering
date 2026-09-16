// One secret key signs staff logins and derives the table codes printed in QR codes.
// Set SESSION_SECRET in production; locally it is generated once and saved in the data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function load() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, secret);
    return secret;
  }
}

const SECRET = load();

module.exports = {
  DATA_DIR,
  sign: (value) => crypto.createHmac('sha256', SECRET).update(value).digest('hex'),
};
