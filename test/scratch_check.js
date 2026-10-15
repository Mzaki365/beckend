require('dotenv').config();
const mongoose = require('mongoose');
const Session = require('../models/Session');
const fs = require('fs');
const path = require('path');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const all = await Session.find({}).lean();
  const withAudio = all.filter(s => s.audioUrl || s.audioFileName);
  console.log('Sessions with audio in DB:', withAudio.length);
  withAudio.forEach(s => {
    const fn = s.audioFileName || (s.audioUrl ? path.basename(s.audioUrl) : null);
    const exists = fn ? fs.existsSync(path.join(__dirname, '..', 'uploads', fn)) : false;
    console.log({
      id: s.sessionId,
      startedAt: s.startedAt,
      audioUrl: s.audioUrl,
      audioFileName: s.audioFileName,
      fileExistsInUploads: exists
    });
  });
  await mongoose.disconnect();
}
check().catch(console.error);
