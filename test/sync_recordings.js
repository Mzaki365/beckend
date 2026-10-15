require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Session = require('../models/Session');

async function syncRecordings() {
  await mongoose.connect(process.env.MONGODB_URI);
  const recDir = path.join(process.env.APPDATA, 'Storelistener', 'recordings');
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  const metaPath = path.join(recDir, 'metadata.json');

  if (!fs.existsSync(metaPath)) {
    console.log('No metadata.json found');
    await mongoose.disconnect();
    return;
  }

  const recordings = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const sessions = await Session.find({}).lean();

  let copied = 0;
  let updated = 0;

  for (const rec of recordings) {
    const srcFile = path.join(recDir, rec.fileName);
    const destFile = path.join(uploadsDir, rec.fileName);

    if (fs.existsSync(srcFile)) {
      if (!fs.existsSync(destFile)) {
        fs.copyFileSync(srcFile, destFile);
        copied++;
      }
    }

    const recStart = new Date(rec.startedAt).getTime();
    // Find closest session within 5 seconds
    const candidates = sessions.filter(s => {
      const sStart = new Date(s.startedAt).getTime();
      return Math.abs(sStart - recStart) <= 5000;
    });

    if (candidates.length > 0) {
      // Pick the closest
      candidates.sort((a, b) => {
        const diffA = Math.abs(new Date(a.startedAt).getTime() - recStart);
        const diffB = Math.abs(new Date(b.startedAt).getTime() - recStart);
        return diffA - diffB;
      });

      const matchedSession = candidates[0];
      if (!matchedSession.audioUrl || !matchedSession.audioFileName) {
        await Session.updateOne(
          { sessionId: matchedSession.sessionId },
          {
            $set: {
              audioFileName: rec.fileName,
              audioUrl: `/uploads/${rec.fileName}`
            }
          }
        );
        updated++;
        console.log(`Linked ${rec.fileName} to session ${matchedSession.sessionId} (${matchedSession.startedAt})`);
      }
    }
  }

  console.log(`Done! Copied ${copied} files, updated ${updated} sessions.`);
  await mongoose.disconnect();
}

syncRecordings().catch(console.error);
