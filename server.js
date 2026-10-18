const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbw6IdTXV95MJUMjTp3ZyDDIHASz9zOIlQ6fgkrxWFru1h5TZKYsHmSgRbc0KV090w9SCg/exec";

// Global Bot State
let sock = null;
let currentQR = null;
let isConnected = false;
let botUser = null;
let backupTimeout = null;

const authDir = path.join(__dirname, 'auth_info_baileys');

// Normalize Bangladesh phone number to WhatsApp JID
function formatJid(phone) {
  let num = String(phone).split('@')[0].split(':')[0].replace(/[^\d]/g, '');
  if (num.startsWith('01') && num.length === 11) {
    num = '88' + num;
  } else if (num.startsWith('1') && num.length === 10) {
    num = '880' + num;
  }
  return num + '@s.whatsapp.net';
}

// Extract pure phone number from JID (handles multi-device :0, :1, and LID)
function extractPhone(jid) {
  if (!jid) return '';
  const base = jid.split('@')[0].split(':')[0];
  let num = base.replace(/[^\d]/g, '');
  if (num.startsWith('880') && num.length === 14) {
    num = num.slice(0, 13);
  } else if (num.startsWith('01') && num.length === 12) {
    num = num.slice(0, 11);
  }
  return num;
}

// ===== CLOUD SESSION PERSISTENCE (Free Render Disk Wipe Protection) =====
// Synchronizes auth credentials with Google Apps Script so restarts never lose the WhatsApp login
async function syncAuthFromCloud() {
  try {
    const credsFile = path.join(authDir, 'creds.json');
    if (fs.existsSync(credsFile)) {
      console.log('📂 Local session found on disk.');
      return;
    }

    console.log('☁️ Checking for existing session in Google Sheets...');
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'GET_WA_SESSION' })
    });
    const data = await res.json();
    if (data && data.status === 'success' && data.files && Object.keys(data.files).length > 0) {
      if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
      for (const [filename, content] of Object.entries(data.files)) {
        fs.writeFileSync(path.join(authDir, filename), content, 'utf8');
      }
      console.log(`✅ Restored ${Object.keys(data.files).length} session files from Google Sheets!`);
    } else {
      console.log('ℹ️ No prior cloud session found. QR code will be generated for scanning.');
    }
  } catch (err) {
    console.warn('⚠️ Could not restore session from cloud:', err.message);
  }
}

function scheduleCloudBackup(delayMs = 3000) {
  if (backupTimeout) clearTimeout(backupTimeout);
  backupTimeout = setTimeout(async () => {
    try {
      if (!fs.existsSync(authDir)) return;
      const fileNames = fs.readdirSync(authDir);
      if (fileNames.length === 0) return;

      const files = {};
      for (const f of fileNames) {
        const fullPath = path.join(authDir, f);
        if (fs.statSync(fullPath).isFile()) {
          files[f] = fs.readFileSync(fullPath, 'utf8');
        }
      }

      await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'SAVE_WA_SESSION',
          files: files
        })
      });
      console.log(`☁️ Synced ${fileNames.length} session files to Google Sheets.`);
    } catch (err) {
      console.warn('⚠️ Cloud session backup warning:', err.message);
    }
  }, delayMs);
}

async function clearCloudAuth() {
  try {
    await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'CLEAR_WA_SESSION' })
    });
    console.log('🗑️ Cleared cloud session from Google Sheets.');
  } catch (err) {
    console.warn('⚠️ Clear cloud session warning:', err.message);
  }
}

// ===== Initialize WhatsApp Baileys Engine =====
async function startWhatsAppBot() {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // Restore session from Google Sheets if authDir is empty (Render free container restart)
  await syncAuthFromCloud();

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Ideal Home Mess', 'Chrome', '120.0.0']
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleCloudBackup();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      isConnected = false;
      console.log('⚡ New QR code generated. Visit Web Dashboard to scan.');
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      botUser = sock.user;
      console.log('✅ WhatsApp connected successfully as:', botUser?.id || botUser?.name);
      scheduleCloudBackup(1000);
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Connection closed due to:', lastDisconnect?.error?.message || lastDisconnect?.error, 'Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startWhatsAppBot, 3000);
      } else {
        console.log('❌ Logged out. Clearing session and regenerating QR...');
        await clearCloudAuth();
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch (e) {}
        setTimeout(startWhatsAppBot, 2000);
      }
    }
  });

  // Handle Incoming WhatsApp Messages from Boarders
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue; // Ignore bot's own messages
      if (msg.key.remoteJid.includes('@g.us')) continue; // Ignore groups

      const senderJid = msg.key.remoteJid;
      // Handle WhatsApp LID privacy IDs if remoteJid is @lid
      const actualJid = (senderJid && senderJid.includes('@lid'))
        ? (msg.key.remoteJidAlt || msg.key.participant || msg.key.participantPn || senderJid)
        : senderJid;
      const senderPhone = extractPhone(actualJid);
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

      if (!text || text.trim() === '') continue;

      console.log(`📩 Incoming message from ${senderPhone} (${senderJid}): "${text}"`);

      // Forward to Google Apps Script Webhook
      try {
        const fetchRes = await fetch(SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'WHATSAPP_BOT',
            sender: senderPhone,
            message: text,
            sendReply: false
          })
        });

        const data = await fetchRes.json();
        if (data && data.reply) {
          console.log(`📤 Sending reply to ${senderPhone}: "${data.reply}"`);
          await sock.sendMessage(senderJid, { text: data.reply });
        }
      } catch (err) {
        console.error('❌ Error forwarding to Google Apps Script:', err.message);
      }
    }
  });
}

// ===== API ROUTES =====

// 1. Web Dashboard (QR Code and Live Connection Status)
app.get('/', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html lang="bn">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ideal Home WhatsApp Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  </head>
  <body class="bg-slate-100 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl border border-slate-200 text-center">
      <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center text-green-600 mx-auto mb-4 text-3xl shadow-inner">
        <i class="fab fa-whatsapp"></i>
      </div>
      <h1 class="text-xl font-extrabold text-slate-800">আইডিয়াল হোম মেস</h1>
      <p class="text-xs text-slate-500 mb-6">প্রাইভেট সেলফ-হোস্টেড WhatsApp বট ইঞ্জিন (Render)</p>

      <div id="statusBox" class="mb-6">
        ${
          isConnected
            ? `<div class="p-5 bg-green-50 border border-green-200 rounded-2xl">
                <div class="inline-flex items-center gap-2 px-3 py-1 bg-green-500 text-white rounded-full text-xs font-bold mb-2">
                  <span class="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                  সংযুক্ত রয়েছে (Connected)
                </div>
                <p class="text-xs text-green-800 font-semibold">বট সফলভাবে লাইভ আছে! বর্ডারদের স্বয়ংক্রিয় মেসেজ সচল রয়েছে।</p>
                <p class="text-xs text-slate-500 font-mono mt-2 font-bold">${botUser?.id ? botUser.id.split(':')[0] : ''}</p>
              </div>`
            : currentQR
            ? `<div class="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex flex-col items-center">
                <div class="inline-flex items-center gap-2 px-3 py-1 bg-amber-500 text-white rounded-full text-xs font-bold mb-3">
                  <span class="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                  QR কোড স্ক্যান করুন
                </div>
                <div class="bg-white p-2 rounded-2xl shadow-md border mb-3">
                  <img src="${currentQR}" alt="WhatsApp QR" class="w-56 h-56 object-contain" />
                </div>
                <p class="text-[11px] text-amber-800 font-medium">WhatsApp > Linked Devices > Link a Device দিয়ে স্ক্যান করুন।</p>
              </div>`
            : `<div class="p-6 bg-slate-50 border border-slate-200 rounded-2xl">
                <i class="fas fa-spinner fa-spin text-2xl text-slate-400 mb-2"></i>
                <p class="text-xs text-slate-500">বট ইঞ্জিন চালু হচ্ছে, অপেক্ষা করুন...</p>
              </div>`
        }
      </div>

      <div class="bg-slate-50 p-3.5 rounded-2xl border text-left text-xs text-slate-600 space-y-1.5 mb-4">
        <p class="font-bold text-slate-700 flex items-center gap-1.5"><i class="fas fa-shield-alt text-green-600"></i> সুবিধা ও নিরাপত্তা:</p>
        <p>• কোনো থার্ড পার্টি নেই, ১০০% আপনার নিয়ন্ত্রণে ও ফ্রি।</p>
        <p>• শুধুমাত্র গুগল শিটে নিবন্ধিত বর্ডারদের মেসেজ পাঠাবে।</p>
        <p>• ২৪ ঘণ্টার কোনো সীমাবদ্ধতা নেই, আনলিমিটেড ফ্রি মেসেজ।</p>
        <p>• ক্লাউড সেশন সিঙ্ক থাকায় রিস্টার্ট হলেও পুনরায় স্ক্যান করতে হবে না।</p>
      </div>

      <button onclick="location.reload()" class="w-full bg-slate-800 hover:bg-slate-900 text-white py-2.5 rounded-xl font-bold text-xs shadow active:scale-95 transition">
        <i class="fas fa-sync-alt mr-1"></i> রিফ্রেশ করুন
      </button>
    </div>
  </body>
  </html>
  `;
  res.send(html);
});

// 2. Health & Status Check Endpoint
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    has_qr: !!currentQR,
    qr: currentQR,
    user: botUser ? { id: botUser.id, name: botUser.name } : null
  });
});

// 3. Keep-Alive Ping Endpoint (for Google Apps Script / UptimeRobot)
app.get('/ping', (req, res) => {
  res.send('pong ' + new Date().toISOString());
});

// 4. Send Single Message API (Called by Google Apps Script)
app.post('/send', async (req, res) => {
  const { phone, message } = req.body;

  if (!isConnected || !sock) {
    return res.status(503).json({ status: 'error', message: 'WhatsApp bot is not connected yet.' });
  }

  if (!phone || !message) {
    return res.status(400).json({ status: 'error', message: 'phone and message are required.' });
  }

  try {
    const jid = formatJid(phone);
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Message sent to ${phone}`);
    res.json({ status: 'success', message: 'Message sent successfully.' });
  } catch (err) {
    console.error(`❌ Failed to send to ${phone}:`, err.message);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// 5. Broadcast Endpoint (Batch sending with safe 1.5s delay)
app.post('/broadcast', async (req, res) => {
  const { messages } = req.body;

  if (!isConnected || !sock) {
    return res.status(503).json({ status: 'error', message: 'WhatsApp bot is not connected.' });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ status: 'error', message: 'messages array is required.' });
  }

  res.json({ status: 'processing', message: `Queued ${messages.length} messages for sending.` });

  (async () => {
    for (const item of messages) {
      if (!item.phone || !item.message) continue;
      try {
        const jid = formatJid(item.phone);
        await sock.sendMessage(jid, { text: item.message });
        await new Promise((r) => setTimeout(r, 1500)); // 1.5s safe delay to prevent anti-spam trigger
      } catch (e) {
        console.error(`Error broadcasting to ${item.phone}:`, e.message);
      }
    }
  })();
});

// Start Express Server and WhatsApp Bot
app.listen(PORT, () => {
  console.log(`🚀 Ideal Home WhatsApp Server running on port ${PORT}`);
  startWhatsAppBot();
});
