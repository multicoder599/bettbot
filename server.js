require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { Bot, session, InlineKeyboard } = require('grammy');
const { conversations, createConversation } = require('@grammyjs/conversations');

const app = express();
app.use(express.json());

// ==========================================
// ENV VALIDATION
// ==========================================
const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'MONGODB_URI', 'MEGAPAY_API_KEY', 'MEGAPAY_EMAIL', 'APP_URL', 'VIP_CHANNEL_ID', 'ADMIN_IDS'];
for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`❌ Missing required env var: ${key}`);
        process.exit(1);
    }
}

const ADMIN_IDS = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())).filter(Boolean);

// ==========================================
// DATABASE SETUP
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => {
        console.error('❌ MongoDB Error:', err);
        process.exit(1);
    });

const userSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: String,
    firstName: String,
    lastName: String,
    phone: String,
    subscriptions: [{
        category: String,
        plan: String,
        amount: Number,
        startDate: Date,
        endDate: Date,
        status: { type: String, enum: ['active', 'expired', 'cancelled'], default: 'active' },
        receiptNumber: String,
        inviteLink: String,
        reminded: { type: Boolean, default: false },
        renewed: { type: Boolean, default: false }
    }],
    lastPromo: Date,
    createdAt: { type: Date, default: Date.now }
});

const promoLogSchema = new mongoose.Schema({
    type: String,
    sentAt: { type: Date, default: Date.now },
    recipients: Number,
    success: Number,
    failed: Number,
    message: String
});

const User = mongoose.model('User', userSchema);
const PromoLog = mongoose.model('PromoLog', promoLogSchema);

// ==========================================
// BOT SETUP
// ==========================================
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Memory store for pending STK transactions
const pendingTransactions = new Map();

bot.use(session({
    initial: () => ({
        selectedCategory: null,
        planName: null,
        amount: 0
    })
}));

bot.use(conversations());

// ==========================================
// ASSETS & MENUS
// ==========================================
const IMG_MAIN_BANNER = process.env.IMG_MAIN_BANNER || "https://tech-ish.com/wp-content/uploads/2023/01/8.jpg";
const IMG_MPESA_BANNER = process.env.IMG_MPESA_BANNER || "https://tech-ish.com/wp-content/uploads/2023/01/8.jpg";

const mainMenu = new InlineKeyboard()
    .text("⚽ VIP PACKAGE 1 ⚽", "cat_1").row()
    .text("🏀 VIP PACKAGE 2 🏀", "cat_2").row()
    .text("🎾 VIP PACKAGE 3 🎾", "cat_3").row()
    .text("💎 ALL OF THE ABOVE 💎", "cat_all").row()
    .text("⚽ VIP PACKAGE 4 ⚽", "cat_4").row()
    .url("💬 Support ↗️", "https://t.me/agentkally").row()
    .text("ℹ️ About", "about")
    .text("📋 Menu", "menu");

const durationMenu = new InlineKeyboard()
    .text("📅 MONTHLY — 30 days | 499 KSHS", "plan_MONTHLY_499").row()
    .text("📅 WEEKLY — 7 days | 199 KSHS", "plan_WEEKLY_199").row()
    .text("📅 BI-WEEKLY — 14 days | 399 KSHS", "plan_BI-WEEKLY_399").row()
    .text("📅 QUARTERLY — 90 days | 799 KSHS", "plan_QUARTERLY_799").row()
    .text("🔙 Back", "back_home")
    .text("🏠 Home", "back_home");

const cancelMenu = new InlineKeyboard()
    .text("🔙 Cancel", "back_home")
    .text("🏠 Home", "back_home");

const renewMenu = (category, plan, amount) => new InlineKeyboard()
    .text(`♻️ RENEW ${plan} — KES ${amount}`, `renew_${plan}_${amount}_${category}`).row()
    .text("🏠 Home", "back_home");

// ==========================================
// HELPER FUNCTIONS
// ==========================================
function getPlanDays(plan) {
    const plans = { MONTHLY: 30, WEEKLY: 7, 'BI-WEEKLY': 14, QUARTERLY: 90 };
    return plans[plan] || 30;
}

function getPlanDisplay(plan) {
    const displays = { 
        MONTHLY: "30 days", 
        WEEKLY: "7 days", 
        'BI-WEEKLY': "14 days", 
        QUARTERLY: "90 days" 
    };
    return displays[plan] || "30 days";
}

async function getOrCreateUser(ctx) {
    const from = ctx.from;
    let user = await User.findOne({ telegramId: from.id });
    if (!user) {
        user = new User({
            telegramId: from.id,
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name
        });
        await user.save();
    }
    return user;
}

async function unbanUserFromChannel(userId) {
    try {
        await bot.api.unbanChatMember(process.env.VIP_CHANNEL_ID, userId);
        return true;
    } catch (err) {
        return false;
    }
}

// ==========================================
// CONVERSATION: M-PESA STK PUSH
// ==========================================
async function mpesaPrompt(conversation, ctx) {
    try {
        let amountToPay = parseFloat(ctx.session?.amount || 0);
        if (amountToPay === 0) amountToPay = 199;

        const categoryName = ctx.session?.selectedCategory || "VIP Access";
        const planName = ctx.session?.planName || "Subscription";

        const numberCtx = await conversation.wait();
        const rawPhone = numberCtx.message?.text;

        if (!rawPhone) {
            await ctx.reply("❌ Invalid input. Please type /start to try again.");
            return;
        }

        try { await numberCtx.deleteMessage(); } catch (e) {}

        let phone = rawPhone.replace(/\D/g, '');
        if (phone.startsWith('0')) phone = '254' + phone.slice(1);
        else if (!phone.startsWith('254')) phone = '254' + phone;

        if (phone.length !== 12) {
            await ctx.reply("❌ Invalid phone number. Please type /start to try again.");
            return;
        }

        const reference = 'DEP' + Date.now();
        const payload = {
            api_key: process.env.MEGAPAY_API_KEY,
            email: process.env.MEGAPAY_EMAIL,
            amount: amountToPay,
            msisdn: phone,
            callback_url: `${process.env.APP_URL}/api/megapay/webhook`,
            description: `VIP: ${planName}`,
            reference: reference
        };

        pendingTransactions.set(phone, {
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
            amount: amountToPay,
            category: categoryName,
            plan: planName,
            phone: phone,
            date: new Date().toLocaleString()
        });

        console.log(`[STK] Firing for ${phone} - KES ${amountToPay}`);

        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);

        await ctx.reply("⏳ STK Push sent to your M-Pesa!\n\n📱 Check your phone and enter PIN to complete payment.\n\n⚠️ Do NOT close this chat. You will receive your access link automatically after payment.", {
            reply_markup: cancelMenu
        });

    } catch (err) {
        console.error('🛑 CONVERSATION ERROR:', err.message);
        await ctx.reply("❌ Session error. Please type /start to try again.");
    }
}

bot.use(createConversation(mpesaPrompt));

// ==========================================
// MEGAPAY WEBHOOK
// ==========================================
app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;

    try {
        const responseCode = data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode;
        if (responseCode != 0) return;

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        const rawCallbackPhone = (data.Msisdn || data.phone || data.PhoneNumber || "").toString();
        const last9 = rawCallbackPhone.replace(/\D/g, '').slice(-9);
        if (last9.length < 9) return;

        let matchedPhone = null;
        let transaction = null;

        for (let [phone, txData] of pendingTransactions.entries()) {
            if (phone.replace(/\D/g, '').endsWith(last9)) {
                matchedPhone = phone;
                transaction = txData;
                break;
            }
        }

        if (!transaction) return;

        // Unban user first (in case they were previously removed)
        await unbanUserFromChannel(transaction.userId);

        const invite = await bot.api.createChatInviteLink(process.env.VIP_CHANNEL_ID, {
            member_limit: 1,
            name: `${transaction.plan} - ${receipt}`
        });

        const endDate = new Date();
        endDate.setDate(endDate.getDate() + getPlanDays(transaction.plan));

        // Save subscription to database
        await User.findOneAndUpdate(
            { telegramId: transaction.userId },
            {
                $set: {
                    username: transaction.username,
                    firstName: transaction.firstName,
                    lastName: transaction.lastName,
                    phone: transaction.phone,
                    lastActivity: new Date()
                },
                $push: {
                    subscriptions: {
                        category: transaction.category,
                        plan: transaction.plan,
                        amount: amount,
                        startDate: new Date(),
                        endDate: endDate,
                        status: 'active',
                        receiptNumber: receipt,
                        inviteLink: invite.invite_link,
                        reminded: false,
                        renewed: false
                    }
                }
            },
            { upsert: true }
        );

        const successText = `🎉 **PAYMENT SUCCESSFUL!**\n\nThank you for your payment! Your transaction has been confirmed and your premium access is now ready.\n\n💰 **PAYMENT DETAILS**\n━━━━━━━━━━━━━━━\n▪️ Amount: KES ${amount}\n▪️ M-Pesa Receipt: ${receipt}\n▪️ Phone: ${rawCallbackPhone}\n▪️ Date: ${transaction.date}\n\n🔗 **CHANNEL ACCESS**\n━━━━━━━━━━━━━━━\n▪️ Channel: ${transaction.category}\n▪️ Plan: ${transaction.plan}\n▪️ Expires: ${endDate.toLocaleDateString()}\n▪️ Usage: Single-use link.\n\n⚠️ **Important:** This link expires in 24 hours and can only be used once.\n\nNeed help? Contact our support team.`;

        const linkMenu = new InlineKeyboard()
            .url(`🔗 JOIN ${transaction.category} 🔗`, invite.invite_link).row()
            .url("💬 Support ↗️", "https://t.me/agentkally");

        await bot.api.sendMessage(transaction.chatId, successText, {
            reply_markup: linkMenu,
            parse_mode: "Markdown"
        });

        pendingTransactions.delete(matchedPhone);
        console.log(`✅ Subscription activated for ${transaction.userId}`);

    } catch (err) {
        console.error("Webhook Error:", err);
    }
});

// ==========================================
// BOT COMMANDS & NAVIGATION
// ==========================================

bot.command("start", async (ctx) => {
    await getOrCreateUser(ctx);
    const welcomeText = `Hello ${ctx.from.first_name || ''}\n🔥 Welcome to VIP ACCESS\nChoose your subscription package below 👇`;
    await ctx.replyWithPhoto(IMG_MAIN_BANNER, { caption: welcomeText, reply_markup: mainMenu });
});

bot.command("status", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const activeSubs = user.subscriptions.filter(s => s.status === 'active' && s.endDate > new Date());

    if (activeSubs.length === 0) {
        return ctx.reply("❌ You have no active subscriptions.\n\nTap below to subscribe:", { reply_markup: mainMenu });
    }

    let text = `📊 **YOUR SUBSCRIPTIONS**\n━━━━━━━━━━━━━━━\n`;
    activeSubs.forEach((sub, i) => {
        const daysLeft = Math.ceil((sub.endDate - new Date()) / (1000 * 60 * 60 * 24));
        text += `\n${i + 1}. ${sub.category}\n   📅 Plan: ${sub.plan}\n   ⏳ ${daysLeft} days remaining\n   📆 Expires: ${sub.endDate.toLocaleDateString()}\n`;
    });

    ctx.reply(text, { parse_mode: "Markdown", reply_markup: mainMenu });
});

// ADMIN COMMANDS
bot.command("admin", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Unauthorized");
    
    const menu = new InlineKeyboard()
        .text("📊 Stats", "admin_stats").row()
        .text("📢 Broadcast Promo", "admin_broadcast").row()
        .text("👥 User List", "admin_users").row()
        .text("🔄 Force Reminder", "admin_remind").row();
    
    ctx.reply("🔧 **ADMIN PANEL**", { parse_mode: "Markdown", reply_markup: menu });
});

bot.command("broadcast", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Unauthorized");
    
    const message = ctx.match;
    if (!message) return ctx.reply("Usage: /broadcast Your promotional message here");
    
    await sendPromoToAll(message, 'manual');
    ctx.reply("✅ Broadcast initiated!");
});

bot.callbackQuery("admin_stats", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const totalUsers = await User.countDocuments();
    const activeSubs = await User.countDocuments({ 'subscriptions.status': 'active', 'subscriptions.endDate': { $gt: new Date() } });
    const todayPayments = await User.countDocuments({ 'subscriptions.startDate': { $gte: new Date(new Date().setHours(0,0,0,0)) } });
    
    await ctx.editMessageText(`📊 **STATS**\n━━━━━━━━━━━━━━━\n👥 Total Users: ${totalUsers}\n✅ Active Subs: ${activeSubs}\n💰 Today Sales: ${todayPayments}`, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("admin_broadcast", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    await ctx.answerCallbackQuery();
    await ctx.reply("Send your broadcast message now or use:\n/broadcast Your message here");
});

bot.callbackQuery("admin_users", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const users = await User.find().sort({ createdAt: -1 }).limit(20);
    let text = `👥 **RECENT USERS**\n━━━━━━━━━━━━━━━\n`;
    users.forEach(u => {
        const active = u.subscriptions.filter(s => s.status === 'active' && s.endDate > new Date()).length;
        text += `\n${u.firstName || 'Unknown'} (@${u.username || 'N/A'})\n🆔 ${u.telegramId} | ✅ ${active} active\n`;
    });
    await ctx.editMessageText(text, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("admin_remind", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    await ctx.answerCallbackQuery("⏳ Running reminders...");
    await runReminders();
    await ctx.reply("✅ Reminders sent!");
});

// CATEGORY HANDLERS
bot.callbackQuery(/^cat_/, async (ctx) => {
    const categories = {
        'cat_1': '⚽ VIP PACKAGE 1 ⚽',
        'cat_2': '🏀 VIP PACKAGE 2 🏀',
        'cat_3': '🎾 VIP PACKAGE 3 🎾',
        'cat_all': '💎 ALL OF THE ABOVE 💎',
        'cat_4': '⚽ VIP PACKAGE 4 ⚽'
    };

    ctx.session.selectedCategory = categories[ctx.callbackQuery.data];
    const durationText = `${ctx.session.selectedCategory}\n\nPay to watch all exclusive content full videos\n\nChoose your plan:`;

    await ctx.editMessageMedia({
        type: 'photo', media: IMG_MPESA_BANNER, caption: durationText, parse_mode: "Markdown"
    }, { reply_markup: durationMenu });

    await ctx.answerCallbackQuery();
});

// PLAN SELECTION
bot.callbackQuery(/^plan_/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split('_');
    ctx.session.planName = parts[1];
    ctx.session.amount = parseInt(parts[2]);

    const planDisplay = getPlanDisplay(parts[1]);
    const confirmText = `${ctx.session.selectedCategory}\n\n📅 Plan: ${planDisplay} — KES ${ctx.session.amount}\n\n📱 **Enter your M-Pesa number:**\nFormat: 07XXXXXXXX or 01XXXXXXXX\n\nType your number in the chat below 👇`;

    await ctx.editMessageCaption({ caption: confirmText, reply_markup: cancelMenu, parse_mode: "Markdown" });
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("mpesaPrompt");
});

// RENEWAL HANDLER
bot.callbackQuery(/^renew_/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split('_');
    ctx.session.planName = parts[1];
    ctx.session.amount = parseInt(parts[2]);
    ctx.session.selectedCategory = parts[3];

    const planDisplay = getPlanDisplay(parts[1]);
    const confirmText = `♻️ **RENEW SUBSCRIPTION**\n\n${ctx.session.selectedCategory}\n📅 Plan: ${planDisplay} — KES ${ctx.session.amount}\n\n📱 **Enter your M-Pesa number:**\nFormat: 07XXXXXXXX or 01XXXXXXXX`;

    await ctx.editMessageCaption({ caption: confirmText, reply_markup: cancelMenu, parse_mode: "Markdown" });
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("mpesaPrompt");
});

bot.callbackQuery("back_home", async (ctx) => {
    await ctx.conversation.exit();
    const welcomeText = `Hello ${ctx.from.first_name || ''}\n🔥 Welcome to VIP ACCESS\nChoose your subscription package below 👇`;
    await ctx.editMessageMedia({
        type: 'photo', media: IMG_MAIN_BANNER, caption: welcomeText
    }, { reply_markup: mainMenu });
    await ctx.answerCallbackQuery();
});

bot.callbackQuery(["about", "menu"], async (ctx) => {
    await ctx.answerCallbackQuery({ text: "This feature is coming soon!" });
});

// ==========================================
// PROMOTIONAL SYSTEM
// ==========================================
async function sendPromoToAll(message, type = 'promo') {
    const users = await User.find();
    let sent = 0, failed = 0;

    for (const user of users) {
        try {
            await bot.api.sendMessage(user.telegramId, `📢 *${type === 'manual' ? 'ANNOUNCEMENT' : 'SPECIAL OFFER'}*\n\n${message}\n\n🔥 Tap /start to subscribe!`, { 
                parse_mode: 'Markdown',
                reply_markup: mainMenu 
            });
            sent++;
            await new Promise(r => setTimeout(r, 50)); // Rate limit protection
        } catch (e) {
            failed++;
        }
    }

    await PromoLog.create({ type, recipients: users.length, success: sent, failed, message });
    console.log(`📢 Promo sent: ${sent} success, ${failed} failed`);
    return { sent, failed };
}

// ==========================================
// CRON JOBS
// ==========================================

// 1. REMINDER JOB - Daily at 9:00 AM
async function runReminders() {
    const now = new Date();
    const twoDaysFromNow = new Date(now);
    twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);
    twoDaysFromNow.setHours(23, 59, 59, 999);

    const twoDaysStart = new Date(now);
    twoDaysStart.setDate(twoDaysStart.getDate() + 2);
    twoDaysStart.setHours(0, 0, 0, 0);

    const users = await User.find({
        'subscriptions.status': 'active',
        'subscriptions.endDate': { $gte: twoDaysStart, $lte: twoDaysFromNow },
        'subscriptions.reminded': false
    });

    for (const user of users) {
        for (const sub of user.subscriptions) {
            if (sub.status !== 'active' || sub.reminded) continue;
            
            const daysLeft = Math.ceil((sub.endDate - now) / (1000 * 60 * 60 * 24));
            if (daysLeft === 2) {
                try {
                    const reminderText = `⏰ **SUBSCRIPTION EXPIRING SOON!**\n\nYour ${sub.category} subscription expires in **2 days** (${sub.endDate.toLocaleDateString()}).\n\nDon't lose access to exclusive content! Renew now:`;
                    
                    await bot.api.sendMessage(user.telegramId, reminderText, {
                        parse_mode: "Markdown",
                        reply_markup: renewMenu(sub.category, sub.plan, sub.amount)
                    });
                    
                    sub.reminded = true;
                    console.log(`⏰ Reminder sent to ${user.telegramId}`);
                } catch (err) {
                    console.error(`Failed to remind ${user.telegramId}:`, err.message);
                }
            }
        }
        await user.save();
    }
}

cron.schedule('0 9 * * *', runReminders);

// 2. EXPIRY & REMOVAL JOB - Every hour
cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const users = await User.find({
        'subscriptions.status': 'active',
        'subscriptions.endDate': { $lt: now }
    });

    for (const user of users) {
        let removed = false;
        
        for (const sub of user.subscriptions) {
            if (sub.status !== 'active' || sub.endDate >= now) continue;
            
            sub.status = 'expired';
            
            // Remove from channel
            try {
                await bot.api.banChatMember(process.env.VIP_CHANNEL_ID, user.telegramId);
                removed = true;
            } catch (err) {
                console.error(`Failed to ban ${user.telegramId}:`, err.message);
            }

            // Send expiry notice with promo
            try {
                const expiryText = `⏰ **SUBSCRIPTION EXPIRED**\n\nYour access to ${sub.category} has ended.\n\n🔥 **RENEW NOW** to continue enjoying exclusive content!\n\n💰 ${sub.plan} — KES ${sub.amount}`;
                
                await bot.api.sendMessage(user.telegramId, expiryText, {
                    parse_mode: "Markdown",
                    reply_markup: renewMenu(sub.category, sub.plan, sub.amount)
                });
            } catch (err) {
                console.error(`Failed to notify expiry ${user.telegramId}:`, err.message);
            }
        }
        
        await user.save();
        if (removed) console.log(`🚫 Removed user ${user.telegramId} from channel`);
    }
});

// 3. WIN-BACK PROMO - Every 3 days at 2 PM to expired users
cron.schedule('0 14 */3 * *', async () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const users = await User.find({
        'subscriptions.status': 'expired',
        'subscriptions.endDate': { $gte: threeDaysAgo, $lt: new Date() },
        $or: [{ lastPromo: { $lt: threeDaysAgo } }, { lastPromo: { $exists: false } }]
    });

    for (const user of users) {
        try {
            await bot.api.sendMessage(user.telegramId, 
                `🔥 **WE MISS YOU!**\n\nYour VIP access expired recently. Here's an exclusive offer:\n\n✅ Renew ANY plan today\n✅ Get instant channel access\n✅ New content dropped daily!\n\nTap /start to grab your spot back!`, 
                { parse_mode: "Markdown", reply_markup: mainMenu }
            );
            user.lastPromo = new Date();
            await user.save();
        } catch (e) {
            // Ignore
        }
    }
});

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx?.update?.update_id}:`);
    const e = err.error;
    if (e?.description) console.error("Telegram API Error:", e.description);
    else console.error("Unknown Error:", e?.message || e);
});

// ==========================================
// START SERVERS
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));
bot.start({ onStart: (botInfo) => console.log(`🤖 Bot @${botInfo.username} started!`) });