const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs').promises; // שימוש ב-fs אסינכרוני
const fsSync = require('fs'); // שימוש ב-fs סינכרוני לקריאת קונפיגורציה
const path = require('path');
const qrcode = require('qrcode-terminal');

const CONFIG_FILE = 'groups_config.json';
let groupConfig;
try {
    groupConfig = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
    console.log('קונפיגורציה נטענה בהצלחה:', groupConfig);
} catch (error) {
    console.error('שגיאה בקריאת קובץ הקונפיגורציה:', error);
    process.exit(1);
}

const processedMessages = new Set();
const messageMapping = new Map();
const TEMP_DIR = './temp_media'; // תיקייה לקבצים זמניים

// פונקציה לוודא שהתיקייה הזמנית קיימת
async function ensureTempDirExists() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (error) {
        console.error("שגיאה ביצירת התיקייה הזמנית:", error);
    }
}

function getActualMessageContent(message) {
    if (message?.documentWithCaptionMessage) {
        return message.documentWithCaptionMessage.message;
    }
    return message;
}

// פונקציית הורדה ששומרת קובץ לדיסק ומחזירה את הנתיב
async function downloadMediaToFile(messageId, mediaMessage, mediaType) {
    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
    const fileExtension = mediaMessage.mimetype.split('/')[1].split(';')[0] || 'bin';
    const filePath = path.join(TEMP_DIR, `${messageId}.${fileExtension}`);
    const writeStream = fsSync.createWriteStream(filePath);

    for await (const chunk of stream) {
        writeStream.write(chunk);
    }
    writeStream.end();
    
    await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
    return filePath;
}

function getRandomDelay() {
    return Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000;
}

async function sendWithDelay(func) {
    const delay = getRandomDelay();
    console.log(`ממתין ${delay / 1000} שניות לפני השליחה הבאה...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return await func();
}

// --- פונקציות העתקה ---
async function copyTextMessage(sock, targetGroupId, message, _) {
    const content = getActualMessageContent(message.message);
    const text = content?.conversation || content?.extendedTextMessage?.text || '';
    if (!text) return null;
    return await sendWithDelay(() => sock.sendMessage(targetGroupId, { text }));
}

async function copyMediaMessage(sock, targetGroupId, message, buffer, type) {
    const content = getActualMessageContent(message.message);
    const quoted = content[`${type}Message`];
    if (!quoted || !buffer) return null;

    const messagePayload = {
        [type]: buffer,
        caption: quoted.caption || undefined,
    };
    if (type === 'document') {
        messagePayload.mimetype = quoted.mimetype;
        messagePayload.fileName = quoted.fileName || 'file';
    }
    
    return await sendWithDelay(() => sock.sendMessage(targetGroupId, messagePayload));
}

// --- פונקציות מחיקה ועריכה ---
async function deleteMessageInTargets(sock, originalMessageId) {
    const targetMessageIds = messageMapping.get(originalMessageId);
    if (!targetMessageIds) return;
    for (const [targetGroupId, messageId] of targetMessageIds.entries()) {
        try {
            await sock.sendMessage(targetGroupId, { delete: { remoteJid: targetGroupId, id: messageId } });
            console.log(`הודעה נמחקה בקבוצת יעד: ${targetGroupId}`);
        } catch (error) {
            console.error(`שגיאה במחיקת הודעה בקבוצה ${targetGroupId}:`, error);
        }
    }
}

async function editMessageInTargets(sock, originalMessageId, newText) {
    const targetMessageIds = messageMapping.get(originalMessageId);
    if (!targetMessageIds) return;
    for (const [targetGroupId, messageId] of targetMessageIds.entries()) {
        try {
            await sock.sendMessage(targetGroupId, { text: newText, edit: { remoteJid: targetGroupId, id: messageId } });
            console.log(`הודעה נערכה בקבוצת יעד: ${targetGroupId}`);
        } catch (error) {
            console.error(`שגיאה בעריכת הודעה בקבוצה ${targetGroupId}:`, error);
        }
    }
}

// --- פונקציית ההעתקה הראשית ---
async function copyMessageToTargets(sock, message) {
    const messageId = message.key.id;
    const senderName = message.pushName || 'משתמש לא ידוע';
    const messageContent = getActualMessageContent(message.message);

    let messageType = 'לא ידוע';
    let mediaTypeForDownload = null;
    let mediaMessageObject = null;

    if (messageContent?.imageMessage) { messageType = 'תמונה'; mediaTypeForDownload = 'image'; mediaMessageObject = messageContent.imageMessage; } 
    else if (messageContent?.videoMessage) { messageType = 'וידאו'; mediaTypeForDownload = 'video'; mediaMessageObject = messageContent.videoMessage; } 
    else if (messageContent?.documentMessage) { messageType = 'מסמך'; mediaTypeForDownload = 'document'; mediaMessageObject = messageContent.documentMessage; } 
    else if (messageContent?.audioMessage) { messageType = 'אודיו'; mediaTypeForDownload = 'audio'; mediaMessageObject = messageContent.audioMessage; } 
    else if (messageContent?.stickerMessage) { messageType = 'סטיקר'; mediaTypeForDownload = 'sticker'; mediaMessageObject = messageContent.stickerMessage; } 
    else if (messageContent?.conversation || messageContent?.extendedTextMessage) { messageType = 'טקסט'; }

    if (messageType === 'לא ידוע') {
        console.log(`התעלמות מהודעה מסוג לא נתמך.`);
        return;
    }
    
    console.log(`זוהה סוג הודעה: ${messageType}.`);

    let mediaBuffer = null;
    let tempFilePath = null;

    if (mediaTypeForDownload && mediaMessageObject) {
        try {
            console.log(`מתחיל הורדה של ${(mediaMessageObject.fileLength / 1024 / 1024).toFixed(2)} MB לקובץ זמני...`);
            tempFilePath = await downloadMediaToFile(messageId, mediaMessageObject, mediaTypeForDownload);
            console.log(`ההורדה הושלמה ונשמרה ב: ${tempFilePath}`);
            mediaBuffer = await fs.readFile(tempFilePath);
        } catch (error) {
            console.error('שגיאה קריטית בהורדת המדיה, התהליך בוטל:', error);
            if (tempFilePath) await fs.unlink(tempFilePath).catch(e => console.error("שגיאה במחיקת קובץ זמני:", e));
            return;
        }
    }

    console.log('מתחיל תהליך העתקה לקבוצות...');
    const targetMessageIds = new Map();
    let successCount = 0;
    let failureCount = 0;
    const startTime = new Date();

    for (const targetGroupId of groupConfig.targetGroupIds) {
        try {
            let sentMessage;
            if (messageType === 'טקסט') {
                sentMessage = await copyTextMessage(sock, targetGroupId, message);
            } else {
                sentMessage = await copyMediaMessage(sock, targetGroupId, message, mediaBuffer, mediaTypeForDownload);
            }
            
            if (sentMessage && sentMessage.key) {
                targetMessageIds.set(targetGroupId, sentMessage.key.id);
                successCount++;
                console.log(`הודעה הועתקה לקבוצה: ${targetGroupId}`);
            } else {
                failureCount++;
                console.log(`כישלון בהעתקת הודעה לקבוצה ${targetGroupId}`);
            }
        } catch (error) {
            console.error(`שגיאה קריטית בהעתקת הודעה לקבוצה ${targetGroupId}:`, error);
            failureCount++;
        }
    }

    if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(e => console.error("שגיאה במחיקת קובץ זמני בסיום:", e));
        console.log("הקובץ הזמני נמחק.");
    }
    
    if (targetMessageIds.size > 0) {
        messageMapping.set(messageId, targetMessageIds);
    }

    const endTime = new Date();
    const totalTime = Math.round((endTime - startTime) / 1000);
    const totalGroups = groupConfig.targetGroupIds.length;
    let summaryMessage = `📊 *דוח סנכרון הודעה*\n\n` +
                       `👤 שולח: ${senderName}\n` +
                       `📝 סוג הודעה: ${messageType}\n` +
                       `✅ הועתק בהצלחה: ${successCount}/${totalGroups} קבוצות\n`;
    if (failureCount > 0) {
        summaryMessage += `❌ כישלונות: ${failureCount}\n`;
    }
    summaryMessage += `⏱️ זמן כולל (שליחה בלבד): ${totalTime} שניות\n` +
                      `🕐 זמן: ${endTime.toLocaleTimeString('he-IL')}\n\n`;
    if (successCount === totalGroups) {
        summaryMessage += `🎯 ההודעה הועתקה בהצלחה לכל הקבוצות!`;
    } else if (successCount > 0) {
        summaryMessage += `⚠️ ההודעה הועתקה חלקית`;
    } else {
        summaryMessage += `🚨 כישלון בהעתקת ההודעה`;
    }

    try {
        await sock.sendMessage(groupConfig.triggerGroupId, { text: summaryMessage });
        console.log('הודעת סיכום נשלחה לקבוצת הטריגר');
    } catch (error) {
        console.error('שגיאה בשליחת הודעת סיכום:', error);
    }
}

// --- פונקציית הבוט הראשית ---
async function startWhatsAppBot() {
    await ensureTempDirExists(); // וידוא שהתיקייה קיימת לפני התחלה
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Group Sync Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('יש לסרוק את קוד ה-QR הבא באמצעות WhatsApp:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('החיבור נסגר בגלל:', lastDisconnect?.error, ', מתחבר מחדש:', shouldReconnect);
            if (shouldReconnect) startWhatsAppBot();
        } else if (connection === 'open') {
            console.log('התחברות ל-WhatsApp הושלמה בהצלחה!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || message.key.remoteJid !== groupConfig.triggerGroupId || message.key.fromMe || processedMessages.has(message.key.id)) {
            return;
        }
        console.log(`זוהתה הודעה חדשה בקבוצת הטריגר מאת ${message.pushName || 'לא ידוע'}.`);
        processedMessages.add(message.key.id);
        await copyMessageToTargets(sock, message);
    });
    
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.key.remoteJid !== groupConfig.triggerGroupId) continue;
            
            // טיפול במחיקת הודעה
            const messageStubType = update.update?.messageStubType;
            if (messageStubType === 1 || messageStubType === 68) { // REVOKE or PROTOCOL_DELETE
                console.log('הודעה נמחקה בקבוצת המקור');
                await deleteMessageInTargets(sock, update.key.id);
            }
            
            // טיפול בעריכת הודעה
            if (update.update?.editedMessage) {
                console.log('הודעה נערכה בקבוצת המקור');
                const newText = update.update.editedMessage.conversation || update.update.editedMessage.extendedTextMessage?.text || '';
                if (newText) {
                    await editMessageInTargets(sock, update.key.id, newText);
                }
            }
        }
    });

    return sock;
}

console.log('מתחיל את בוט סנכרון קבוצות WhatsApp...');
startWhatsAppBot().catch(console.error);

process.on('SIGINT', () => {
    console.log('סוגר את הבוט...');
    fsSync.rmSync(TEMP_DIR, { recursive: true, force: true }); // ניקוי קבצים זמניים ביציאה
    process.exit(0);
});

module.exports = { startWhatsAppBot };
