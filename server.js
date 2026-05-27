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
const VIP_CHANNEL_ID = process.env.VIP_CHANNEL_ID;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || null;

// ==========================================
// DATABASE
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
    isActive: { type: Boolean, default: true },
    subscriptions: [{
        category: String,
        categoryKey: String,
        plan: String,
        amount: Number,
        startDate: Date,
        endDate: Date,
        status: { type: String, enum: ['active', 'expired', 'cancelled'], default: 'active' },
        receiptNumber: String,
        inviteLink: String,
        reminderLevel: { type: Number, default: 0 },
        renewed: { type: Boolean, default: false }
    }],
    lastPromo: Date,
    bannedFromChannel: { type: Boolean, default: false },
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
const pendingTransactions = new Map();

const userIntent = new Map();

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
const IMG_MAIN_BANNER = process.env.IMG_MAIN_BANNER || "https://i.imgur.com/iNaOiyf.jpg";
const IMG_MPESA_BANNER = process.env.IMG_MPESA_BANNER || "https://i.imgur.com/iNaOiyf.jpg";

const CATEGORIES = {
    'cat_1': '📺🔞KENYAN PORN ⛔',
    'cat_2': '📺TRENDING LEAKS🔞💦',
    'cat_3': '📺❤SOMALIA PORN❤',
    'cat_4': '❤CELEBRITY LEAKS💦📺',
    'cat_all': '💎ALL OF THE ABOVE❤💎'
};

const mainMenu = new InlineKeyboard()
    .text("📺🔞KENYAN PORN ⛔", "cat_1").row()
    .text("📺TRENDING LEAKS🔞💦", "cat_2").row()
    .text("📺❤SOMALIA PORN❤", "cat_3").row()
    .text("❤CELEBRITY LEAKS💦📺", "cat_4").row()
    .text("💎ALL OF THE ABOVE❤💎", "cat_all").row()
    .text("👤 My Account", "my_account").row()
    .url("💬 Support ↗️", "https://t.me/theopperator").row()
    .text("ℹ️ About", "about")
    .text("📋 Menu", "menu");

const CATEGORY_PRICES = {
    'cat_1': { 'WEEKLY': 199, 'MONTHLY': 299, 'QUARTERLY': 499, 'LIFETIME': 999 },
    'cat_2': { 'WEEKLY': 299, 'MONTHLY': 499, 'QUARTERLY': 799, 'LIFETIME': 1499 },
    'cat_3': { 'WEEKLY': 199, 'MONTHLY': 299, 'QUARTERLY': 488, 'LIFETIME': 999 },
    'cat_4': { 'WEEKLY': 299, 'MONTHLY': 499, 'QUARTERLY': 799, 'LIFETIME': 1499 },
    'cat_all': { 'WEEKLY': 399, 'MONTHLY': 599, 'QUARTERLY': 899, 'LIFETIME': 1999 }
};

const PLAN_LABELS = {
    'WEEKLY': '1 Week — 7 days',
    'MONTHLY': '1 MONTH — 30 days',
    'QUARTERLY': '3 MONTHS — 90 days',
    'LIFETIME': 'LIFETIME'
};

function getDurationMenu(categoryKey) {
    const prices = CATEGORY_PRICES[categoryKey];
    const menu = new InlineKeyboard();
    for (const [plan, amount] of Object.entries(prices)) {
        menu.text(`📅 ${PLAN_LABELS[plan]} | ${amount} KSHS`, `plan_${plan}_${amount}`).row();
    }
    menu.text("🔙 Back", "back_home").text("🏠 Home", "back_home");
    return menu;
}

const cancelMenu = new InlineKeyboard()
    .text("🔙 Cancel", "back_home")
    .text("🏠 Home", "back_home");

function psychologyRenewMenu(categoryKey, currentPlan) {
    const prices = CATEGORY_PRICES[categoryKey];
    const menu = new InlineKeyboard();
    const planOrder = ['LIFETIME', 'QUARTERLY', 'MONTHLY', 'WEEKLY'];
    const rank = { WEEKLY: 1, MONTHLY: 2, QUARTERLY: 3, LIFETIME: 4 };
    const currentRank = rank[currentPlan] || 0;
    
    planOrder.forEach(plan => {
        if (!prices[plan]) return;
        const amount = prices[plan];
        const isCurrent = plan === currentPlan;
        const isUpgrade = rank[plan] > currentRank;
        
        let prefix = '';
        if (isCurrent) prefix = '♻️ ';
        else if (plan === 'LIFETIME') prefix = '💎 ';
        else if (plan === 'QUARTERLY') prefix = '🔥 ';
        else if (plan === 'MONTHLY') prefix = '⭐ ';
        
        let suffix = '';
        if (isCurrent) suffix = ' (Current)';
        else if (isUpgrade) suffix = ' 🚀 UPGRADE';
        
        menu.text(`${prefix}${PLAN_LABELS[plan]} | ${amount} KSHS${suffix}`, `renew_${plan}_${amount}_${categoryKey}`).row();
    });
    
    menu.text("🏠 Home", "back_home");
    return menu;
}

// ==========================================
// HELPERS
// ==========================================
function getPlanDays(plan) {
    const plans = { 'WEEKLY': 7, 'MONTHLY': 30, 'QUARTERLY': 90, 'LIFETIME': 36500 };
    return plans[plan] || 30;
}

function getPlanDisplay(plan) {
    const displays = { 'WEEKLY': "7 days", 'MONTHLY': "30 days", 'QUARTERLY': "90 days", 'LIFETIME': "Lifetime access" };
    return displays[plan] || "30 days";
}

function getCategoryKeyFromSub(sub) {
    if (sub.categoryKey) return sub.categoryKey;
    for (const [key, name] of Object.entries(CATEGORIES)) {
        if (name === sub.category) return key;
    }
    return 'cat_1';
}

async function getOrCreateUser(ctx) {
    const from = ctx.from;
    let user = await User.findOne({ telegramId: from.id });
    if (!user) {
        user = new User({
            telegramId: from.id,
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name,
            isActive: true
        });
        await user.save();
    } else if (user.isActive === false) {
        user.isActive = true;
        await user.save();
    }
    return user;
}

async function unbanUserFromChannel(userId) {
    try {
        await bot.api.unbanChatMember(VIP_CHANNEL_ID, userId);
        await User.findOneAndUpdate({ telegramId: userId }, { bannedFromChannel: false });
        return true;
    } catch (err) {
        return false;
    }
}

async function banUserFromChannel(userId) {
    try {
        await bot.api.banChatMember(VIP_CHANNEL_ID, userId);
        await User.findOneAndUpdate({ telegramId: userId }, { bannedFromChannel: true });
        return true;
    } catch (err) {
        return false;
    }
}

// ✅ SAFE EDIT: Handles both text-only and media messages
async function safeEditMessage(ctx, text, replyMarkup, parseMode = "Markdown") {
    try {
        if (ctx.callbackQuery.message.photo && ctx.callbackQuery.message.photo.length > 0) {
            await ctx.editMessageCaption({ caption: text, reply_markup: replyMarkup, parse_mode: parseMode });
        } else {
            await ctx.editMessageText(text, { reply_markup: replyMarkup, parse_mode: parseMode });
        }
    } catch (err) {
        console.error("safeEditMessage error:", err.message);
        await ctx.reply(text, { reply_markup: replyMarkup, parse_mode: parseMode });
    }
}

// ✅ ACCOUNT VIEW HELPERS
function getAccountText(user) {
    const activeSubs = user.subscriptions.filter(s => s.status === 'active' && s.endDate > new Date());
    let text = `👤 **MY ACCOUNT**\n━━━━━━━━━━━━━━━\n`;
    text += `Welcome back, **${user.firstName || 'VIP Member'}**${user.username ? ' (@' + user.username + ')' : ''}!\n\n`;
    
    if (activeSubs.length === 0) {
        text += `❌ You have no active subscriptions.\n\nTap below to subscribe or renew 👇`;
    } else {
        text += `📦 **ACTIVE SUBSCRIPTIONS**\n━━━━━━━━━━━━━━━\n`;
        activeSubs.forEach((sub, i) => {
            const daysLeft = Math.ceil((sub.endDate - new Date()) / (1000 * 60 * 60 * 24));
            text += `\n${i + 1}. **${sub.category}**\n`;
            text += `   📅 Plan: ${sub.plan} (${getPlanDisplay(sub.plan)})\n`;
            text += `   💵 Amount: KES ${sub.amount}\n`;
            text += `   ⏳ Expires in: **${daysLeft} days**\n`;
            text += `   📆 Expiry Date: ${sub.endDate.toLocaleDateString()}\n`;
        });
    }
    return text;
}

function getAccountMenu(user) {
    const menu = new InlineKeyboard();
    const activeSubs = user.subscriptions.filter(s => s.status === 'active' && s.endDate > new Date());
    
    if (activeSubs.length > 0) {
        // Renew buttons for each active subscription
        activeSubs.forEach(sub => {
            const catKey = getCategoryKeyFromSub(sub);
            const prices = CATEGORY_PRICES[catKey];
            if (prices && prices[sub.plan]) {
                menu.text(`♻️ Renew ${sub.category} — ${sub.plan}`, `renew_${sub.plan}_${prices[sub.plan]}_${catKey}`).row();
            }
        });
        
        // Suggestive plans from the first active category
        if (activeSubs.length >= 1) {
            const sub = activeSubs[0];
            const catKey = getCategoryKeyFromSub(sub);
            const prices = CATEGORY_PRICES[catKey];
            const planOrder = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'LIFETIME'];
            const rank = { WEEKLY: 1, MONTHLY: 2, QUARTERLY: 3, LIFETIME: 4 };
            const currentRank = rank[sub.plan] || 0;
            
            planOrder.forEach(plan => {
                if (!prices || !prices[plan] || plan === sub.plan) return;
                const amount = prices[plan];
                const isUpgrade = rank[plan] > currentRank;
                const prefix = isUpgrade ? '🚀' : '⭐';
                menu.text(`${prefix} ${PLAN_LABELS[plan]} | ${amount} KSHS`, `renew_${plan}_${amount}_${catKey}`).row();
            });
        }
    } else {
        menu.text("💎 Get VIP Access", "back_home").row();
    }
    
    menu.text("🏠 Home", "back_home");
    return menu;
}

async function notifyAdminNewSubscription(user, sub) {
    const planDetail = `${sub.category} — ${sub.plan}`;
    const text = `💰 **NEW SALE: ${planDetail}**\n━━━━━━━━━━━━━━━\n👤 ${user.firstName || 'Unknown'} (@${user.username || 'N/A'})\n🆔 ${user.telegramId}\n📱 ${user.phone || 'N/A'}\n📦 ${sub.category}\n📅 ${sub.plan}\n💵 KES ${sub.amount}\n🕐 ${sub.startDate.toLocaleString()}`;
    
    if (ADMIN_CHANNEL_ID) {
        try {
            await bot.api.sendMessage(ADMIN_CHANNEL_ID, text, { parse_mode: "Markdown" });
        } catch (e) {
            console.error('Admin channel notify (new) failed:', e.message);
        }
    }
    
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.api.sendMessage(adminId, text, { parse_mode: "Markdown" });
        } catch (e) {
            console.error(`Admin DM notify (new) failed for ${adminId}:`, e.message);
        }
    }
}

async function notifyAdminRemoval(user, sub) {
    const planDetail = `${sub.category} — ${sub.plan}`;
    const text = `🚫 **REMOVED: ${planDetail}**\n━━━━━━━━━━━━━━━\n👤 ${user.firstName || 'Unknown'} (@${user.username || 'N/A'})\n🆔 ${user.telegramId}\n📦 ${sub.category}\n📅 ${sub.plan} (expired)\n🕐 ${new Date().toLocaleString()}`;
    
    if (ADMIN_CHANNEL_ID) {
        try {
            await bot.api.sendMessage(ADMIN_CHANNEL_ID, text, { parse_mode: "Markdown" });
        } catch (e) {
            console.error('Admin channel notify (removal) failed:', e.message);
        }
    }
    
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.api.sendMessage(adminId, text, { parse_mode: "Markdown" });
        } catch (e) {
            console.error(`Admin DM notify (removal) failed for ${adminId}:`, e.message);
        }
    }
}

// ==========================================
// CONVERSATION: M-PESA STK PUSH
// ==========================================
async function mpesaPrompt(conversation, ctx) {
    try {
        const intent = userIntent.get(ctx.from.id);
        const categoryName = intent?.category || "VIP Access";
        const planName = intent?.plan || "Subscription";
        let amountToPay = parseFloat(intent?.amount || 0);
        const catKey = intent?.categoryKey || "cat_1";
        
        if (amountToPay === 0) amountToPay = 199;

        const numberCtx = await conversation.wait();
        const rawPhone = numberCtx.message?.text;

        if (!rawPhone) {
            await ctx.reply("❌ Invalid input. Type /start to try again.");
            userIntent.delete(ctx.from.id);
            return;
        }

        try { await numberCtx.deleteMessage(); } catch (e) {}

        let phone = rawPhone.replace(/\D/g, '');
        if (phone.startsWith('0')) phone = '254' + phone.slice(1);
        else if (!phone.startsWith('254')) phone = '254' + phone;

        if (phone.length !== 12) {
            await ctx.reply("❌ Invalid phone number. Type /start to try again.");
            userIntent.delete(ctx.from.id);
            return;
        }

        await ctx.reply("⏳ Sending M-Pesa prompt to your phone...\n\n📱 Please check for the STK push and enter your PIN.", {
            reply_markup: cancelMenu
        });

        const reference = 'DEP' + Date.now();
        const payload = {
            api_key: process.env.MEGAPAY_API_KEY,
            email: process.env.MEGAPAY_EMAIL,
            amount: amountToPay,
            msisdn: phone,
            callback_url: `${process.env.APP_URL}/api/megapay/webhook`,
            description: `${categoryName} — ${planName}`,
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
            categoryKey: catKey,
            plan: planName,
            phone: phone,
            date: new Date().toLocaleString()
        });

        console.log(`[STK] Firing for ${phone} - KES ${amountToPay} (${categoryName} ${planName})`);

        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);

    } catch (err) {
        console.error('🛑 CONVERSATION ERROR:', err.message);
        await ctx.reply("❌ Payment initiation failed. Type /start to try again.");
    } finally {
        userIntent.delete(ctx.from.id);
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
        console.log('[WEBHOOK] Received:', JSON.stringify(data));

        const responseCode = data.ResultCode !== undefined ? data.ResultCode : (data.ResponseCode !== undefined ? data.ResponseCode : 1);
        if (parseInt(responseCode) !== 0) {
            console.log(`[WEBHOOK] Payment failed with code: ${responseCode}`);
            return;
        }

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount || 0);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.ReceiptNo || 'N/A';
        const rawCallbackPhone = (data.Msisdn || data.phone || data.PhoneNumber || data.msisdn || "").toString();
        const last9 = rawCallbackPhone.replace(/\D/g, '').slice(-9);

        if (last9.length < 9) {
            console.log('[WEBHOOK] Invalid phone in callback');
            return;
        }

        let matchedPhone = null;
        let transaction = null;

        for (let [phone, txData] of pendingTransactions.entries()) {
            if (phone.replace(/\D/g, '').endsWith(last9)) {
                matchedPhone = phone;
                transaction = txData;
                break;
            }
        }

        if (!transaction) {
            console.log(`[WEBHOOK] No pending transaction found for phone ending: ${last9}`);
            return;
        }

        console.log(`[WEBHOOK] Match found for user ${transaction.userId} — ${transaction.category} ${transaction.plan}`);

        await unbanUserFromChannel(transaction.userId);

        const invite = await bot.api.createChatInviteLink(VIP_CHANNEL_ID, {
            member_limit: 1,
            name: `${transaction.category} ${transaction.plan} — ${receipt}`,
            expire_date: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
        });

        const endDate = new Date();
        endDate.setDate(endDate.getDate() + getPlanDays(transaction.plan));

        const user = await User.findOneAndUpdate(
            { telegramId: transaction.userId },
            {
                $set: {
                    username: transaction.username,
                    firstName: transaction.firstName,
                    lastName: transaction.lastName,
                    phone: transaction.phone,
                    bannedFromChannel: false,
                    isActive: true
                },
                $push: {
                    subscriptions: {
                        category: transaction.category,
                        categoryKey: transaction.categoryKey,
                        plan: transaction.plan,
                        amount: amount,
                        startDate: new Date(),
                        endDate: endDate,
                        status: 'active',
                        receiptNumber: receipt,
                        inviteLink: invite.invite_link,
                        reminderLevel: 0,
                        renewed: false
                    }
                }
            },
            { upsert: true, new: true, returnDocument: 'after' }
        );

        const successText = `🎉 **PAYMENT SUCCESSFUL!**\n\nThank you for your payment! Your premium access is now ready.\n\n💰 **PAYMENT DETAILS**\n━━━━━━━━━━━━━━━\n▪️ Amount: KES ${amount}\n▪️ M-Pesa Receipt: ${receipt}\n▪️ Phone: ${rawCallbackPhone}\n▪️ Date: ${transaction.date}\n\n🔗 **CHANNEL ACCESS**\n━━━━━━━━━━━━━━━\n▪️ Channel: ${transaction.category}\n▪️ Plan: ${transaction.plan}\n▪️ Expires: ${endDate.toLocaleDateString()}\n\n⚠️ **ONE-TIME LINK:** This link can only be used **ONCE**. Once you click and join, it dies immediately. Do NOT share it.\n\nNeed help? Contact our support team.`;

        const linkMenu = new InlineKeyboard()
            .url(`🔗 JOIN ${transaction.category} 🔗`, invite.invite_link).row()
            .url("💬 Support ↗️", "https://t.me/theopperator");

        await bot.api.sendMessage(transaction.chatId, successText, {
            reply_markup: linkMenu,
            parse_mode: "Markdown"
        });

        const newSub = user.subscriptions[user.subscriptions.length - 1];
        await notifyAdminNewSubscription(user, newSub);

        pendingTransactions.delete(matchedPhone);
        console.log(`✅ Subscription activated: ${transaction.category} ${transaction.plan} for ${transaction.userId} until ${endDate.toISOString()}`);

    } catch (err) {
        console.error("[WEBHOOK] Fatal Error:", err.message);
    }
});

// ==========================================
// BOT COMMANDS & NAVIGATION
// ==========================================

bot.command("start", async (ctx) => {
    await getOrCreateUser(ctx);
    const welcomeText = `Hello ${ctx.from.first_name || ''}\n🔥 Welcome to 🥵💦SABLENYA VIP ACCESS❤\nChoose your subscription package below 👇`;
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

// ✅ NEW: /account command
bot.command("account", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const text = getAccountText(user);
    const menu = getAccountMenu(user);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: menu });
});

// ADMIN COMMANDS
bot.command("admin", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Unauthorized");
    
    const menu = new InlineKeyboard()
        .text("📊 Stats + Breakdown", "admin_stats").row()
        .text("📢 Broadcast Promo", "admin_broadcast").row()
        .text("👥 24H Sales Report", "admin_users").row()
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
    
    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);
    
    const todayUsers = await User.find({ 'subscriptions.startDate': { $gte: todayStart } });
    let todayCount = 0;
    let todayRevenue = 0;
    
    const categoryBreakdown = {};
    const planBreakdown = {};
    
    todayUsers.forEach(u => {
        u.subscriptions.forEach(s => {
            if (s.startDate >= todayStart) {
                todayCount++;
                todayRevenue += s.amount || 0;
                
                if (!categoryBreakdown[s.category]) {
                    categoryBreakdown[s.category] = { count: 0, revenue: 0 };
                }
                categoryBreakdown[s.category].count++;
                categoryBreakdown[s.category].revenue += s.amount;
                
                const planKey = `${s.category} — ${s.plan}`;
                if (!planBreakdown[planKey]) {
                    planBreakdown[planKey] = { count: 0, revenue: 0 };
                }
                planBreakdown[planKey].count++;
                planBreakdown[planKey].revenue += s.amount;
            }
        });
    });
    
    let breakdownText = '';
    const sortedPlans = Object.entries(planBreakdown).sort((a, b) => b[1].count - a[1].count);
    sortedPlans.forEach(([plan, data]) => {
        breakdownText += `\n${plan}: ${data.count} sales — KES ${data.revenue}`;
    });
    
    let text = `📊 **TODAY'S STATS**\n━━━━━━━━━━━━━━━\n`;
    text += `👥 Total Users: ${totalUsers}\n`;
    text += `✅ Active Subs: ${activeSubs}\n`;
    text += `💰 Today: ${todayCount} subs — KES ${todayRevenue}\n`;
    text += `📅 ${todayStart.toLocaleDateString()}\n`;
    
    if (sortedPlans.length > 0) {
        text += `\n🏆 **TOP PERFORMERS TODAY**\n━━━━━━━━━━━━━━━${breakdownText}\n`;
    }
    
    await ctx.editMessageText(text, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("admin_broadcast", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    await ctx.answerCallbackQuery();
    await ctx.reply("Send your broadcast message now or use:\n/broadcast Your message here");
});

bot.callbackQuery("admin_users", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const users = await User.find({
        'subscriptions.startDate': { $gte: twentyFourHoursAgo }
    }).sort({ 'subscriptions.startDate': -1 });
    
    const planBreakdown = {};
    let totalAmount = 0;
    let count = 0;
    let userList = '';
    
    users.forEach(u => {
        const recentSubs = u.subscriptions.filter(s => s.startDate >= twentyFourHoursAgo);
        recentSubs.forEach(sub => {
            count++;
            totalAmount += sub.amount || 0;
            
            const planKey = `${sub.category} — ${sub.plan}`;
            if (!planBreakdown[planKey]) {
                planBreakdown[planKey] = { count: 0, revenue: 0, users: [] };
            }
            planBreakdown[planKey].count++;
            planBreakdown[planKey].revenue += sub.amount;
            planBreakdown[planKey].users.push({
                name: u.firstName || 'Unknown',
                username: u.username || 'N/A',
                id: u.telegramId,
                time: sub.startDate.toLocaleString()
            });
            
            userList += `\n${count}. ${u.firstName || 'Unknown'} (@${u.username || 'N/A'})\n`;
            userList += `   📦 ${sub.category} — ${sub.plan}\n`;
            userList += `   💵 KES ${sub.amount} | 🕐 ${sub.startDate.toLocaleString()}\n`;
        });
    });
    
    let breakdownText = '';
    const sortedPlans = Object.entries(planBreakdown).sort((a, b) => b[1].count - a[1].count);
    let rank = 1;
    sortedPlans.forEach(([plan, data]) => {
        breakdownText += `\n${rank}. ${plan}\n   📊 ${data.count} sold | 💰 KES ${data.revenue}`;
        rank++;
    });
    
    let text = `📋 **24H SALES REPORT**\n━━━━━━━━━━━━━━━\n`;
    text += `👥 Total Subscriptions: ${count}\n`;
    text += `💰 Total Revenue: KES ${totalAmount}\n`;
    
    if (sortedPlans.length > 0) {
        text += `\n🏆 **SALES BY PLAN (Ranked)**\n━━━━━━━━━━━━━━━${breakdownText}\n`;
    }
    
    text += `\n━━━━━━━━━━━━━━━\n👤 **DETAILED LIST**\n━━━━━━━━━━━━━━━${userList || '\nNo sales in last 24 hours.'}`;
    
    if (text.length > 4000) {
        text = text.substring(0, 4000) + '\n\n... (truncated)';
    }
    
    await ctx.editMessageText(text, { parse_mode: "Markdown" });
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("admin_remind", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    await ctx.answerCallbackQuery("⏳ Running reminders...");
    await runReminders();
    await ctx.reply("✅ Reminders sent!");
});

// ✅ NEW: My Account callback
bot.callbackQuery("my_account", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const text = getAccountText(user);
    const menu = getAccountMenu(user);
    await safeEditMessage(ctx, text, menu, "Markdown");
    await ctx.answerCallbackQuery();
});

// CATEGORY & PLAN HANDLERS
bot.callbackQuery(/^cat_/, async (ctx) => {
    const catKey = ctx.callbackQuery.data;
    ctx.session.selectedCategory = CATEGORIES[catKey];
    ctx.session.categoryKey = catKey;
    
    const durationText = `${ctx.session.selectedCategory}\n\nPay to watch all exclusive content full videos\n\nChoose your plan:`;
    
    await ctx.editMessageMedia({
        type: 'photo', media: IMG_MPESA_BANNER, caption: durationText, parse_mode: "Markdown"
    }, { reply_markup: getDurationMenu(catKey) });
    
    await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^plan_/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const match = data.match(/^plan_([A-Z-]+)_(\d+)$/);
    if (!match) return;
    
    const plan = match[1];
    const amount = parseInt(match[2]);

    userIntent.set(ctx.from.id, {
        category: ctx.session.selectedCategory,
        categoryKey: ctx.session.categoryKey || 'cat_1',
        plan: plan,
        amount: amount
    });

    ctx.session.planName = plan;
    ctx.session.amount = amount;

    const planDisplay = getPlanDisplay(plan);
    const confirmText = `${ctx.session.selectedCategory}\n\n📅 Plan: ${planDisplay} — KES ${amount}\n\n📱 **Enter your M-Pesa number:**\nFormat: 07XXXXXXXX or 01XXXXXXXX\n\nType your number in the chat below 👇`;

    await safeEditMessage(ctx, confirmText, cancelMenu, "Markdown");
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("mpesaPrompt");
});

bot.callbackQuery(/^renew_/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const match = data.match(/^renew_([A-Z-]+)_(\d+)_(cat_.+)$/);
    if (!match) return;
    
    const plan = match[1];
    const amount = parseInt(match[2]);
    const categoryKey = match[3];

    userIntent.set(ctx.from.id, {
        category: CATEGORIES[categoryKey],
        categoryKey: categoryKey,
        plan: plan,
        amount: amount
    });

    ctx.session.planName = plan;
    ctx.session.amount = amount;
    ctx.session.selectedCategory = CATEGORIES[categoryKey];

    const planDisplay = getPlanDisplay(plan);
    const confirmText = `♻️ **RENEW SUBSCRIPTION**\n\n${ctx.session.selectedCategory}\n📅 Plan: ${planDisplay} — KES ${amount}\n\n📱 **Enter your M-Pesa number:**\nFormat: 07XXXXXXXX or 01XXXXXXXX`;

    await safeEditMessage(ctx, confirmText, cancelMenu, "Markdown");
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("mpesaPrompt");
});

bot.callbackQuery("back_home", async (ctx) => {
    await ctx.conversation.exit();
    userIntent.delete(ctx.from.id);
    const welcomeText = `Hello ${ctx.from.first_name || ''}\n🔥 Welcome to VIP ACCESS\nChoose your subscription package below 👇`;
    
    try {
        if (ctx.callbackQuery.message.photo && ctx.callbackQuery.message.photo.length > 0) {
            await ctx.editMessageMedia({
                type: 'photo', media: IMG_MAIN_BANNER, caption: welcomeText
            }, { reply_markup: mainMenu });
        } else {
            try { await ctx.deleteMessage(); } catch (e) {}
            await ctx.replyWithPhoto(IMG_MAIN_BANNER, { caption: welcomeText, reply_markup: mainMenu });
        }
    } catch (err) {
        console.error("back_home error:", err.message);
        await ctx.replyWithPhoto(IMG_MAIN_BANNER, { caption: welcomeText, reply_markup: mainMenu });
    }
    await ctx.answerCallbackQuery();
});

bot.callbackQuery(["about", "menu"], async (ctx) => {
    await ctx.answerCallbackQuery({ text: "This feature is coming soon!" });
});

// ==========================================
// PROMOTIONAL SYSTEM
// ==========================================
async function sendPromoToAll(message, type = 'promo') {
    const users = await User.find({ isActive: { $ne: false } });
    let sent = 0, failed = 0;

    for (const user of users) {
        try {
            await bot.api.sendMessage(user.telegramId, `📢 *${type === 'manual' ? 'ANNOUNCEMENT' : 'SPECIAL OFFER'}*\n\n${message}\n\n🔥 Tap /start to subscribe!`, { 
                parse_mode: 'Markdown',
                reply_markup: mainMenu 
            });
            sent++;
            await new Promise(r => setTimeout(r, 50));
        } catch (e) {
            failed++;
            if (e.description === "Forbidden: bot was blocked by the user") {
                console.log(`User ${user.telegramId} blocked the bot during promo. Marking inactive.`);
                await User.updateOne({ telegramId: user.telegramId }, { isActive: false });
            }
        }
    }

    await PromoLog.create({ type, recipients: users.length, success: sent, failed, message });
    console.log(`📢 Promo sent: ${sent} success, ${failed} failed`);
    return { sent, failed };
}

// ==========================================
// CRON JOBS — 3-STAGE REMINDER + EXPIRY
// ==========================================

async function runReminders() {
    const now = new Date();
    
    const twoDaysStart = new Date(now);
    twoDaysStart.setDate(twoDaysStart.getDate() + 2);
    twoDaysStart.setHours(0, 0, 0, 0);
    const twoDaysEnd = new Date(now);
    twoDaysEnd.setDate(twoDaysEnd.getDate() + 2);
    twoDaysEnd.setHours(23, 59, 59, 999);

    const users2Days = await User.find({
        isActive: { $ne: false },
        subscriptions: {
            $elemMatch: {
                status: 'active',
                endDate: { $gte: twoDaysStart, $lte: twoDaysEnd },
                $or: [{ reminderLevel: { $exists: false } }, { reminderLevel: { $lt: 1 } }]
            }
        }
    });

    for (const user of users2Days) {
        let saved = false;
        for (const sub of user.subscriptions) {
            if (sub.status !== 'active') continue;
            if (sub.endDate < twoDaysStart || sub.endDate > twoDaysEnd) continue;
            if ((sub.reminderLevel || 0) >= 1) continue;
            
            try {
                const catKey = getCategoryKeyFromSub(sub);
                const text = `⏰ **SUBSCRIPTION EXPIRING SOON**\n\nYour ${sub.category} (${sub.plan}) expires in **2 days** (${sub.endDate.toLocaleDateString()}).\n\n💡 **Smart move:** Most VIP members upgrade to longer plans. Why? Better value, zero interruptions, and you lock in today's price.\n\n🔥 **Popular upgrades:**\n• 3 Months — save 40% vs weekly\n• Lifetime — never pay again\n\n👇 Renew or upgrade below:`;
                
                await bot.api.sendMessage(user.telegramId, text, {
                    parse_mode: "Markdown",
                    reply_markup: psychologyRenewMenu(catKey, sub.plan)
                });
                
                sub.reminderLevel = 1;
                saved = true;
                console.log(`⏰ 2-day reminder sent to ${user.telegramId}`);
            } catch (err) {
                if (err.description === "Forbidden: bot was blocked by the user") {
                    console.log(`User ${user.telegramId} blocked bot. Marking inactive.`);
                    user.isActive = false;
                    saved = true; 
                } else {
                    console.error(`Failed 2-day remind ${user.telegramId}:`, err.message);
                }
            }
        }
        if (saved) await user.save();
    }

    const oneDayStart = new Date(now);
    oneDayStart.setDate(oneDayStart.getDate() + 1);
    oneDayStart.setHours(0, 0, 0, 0);
    const oneDayEnd = new Date(now);
    oneDayEnd.setDate(oneDayEnd.getDate() + 1);
    oneDayEnd.setHours(23, 59, 59, 999);

    const users1Day = await User.find({
        isActive: { $ne: false },
        subscriptions: {
            $elemMatch: {
                status: 'active',
                endDate: { $gte: oneDayStart, $lte: oneDayEnd },
                $or: [{ reminderLevel: { $exists: false } }, { reminderLevel: { $lt: 2 } }]
            }
        }
    });

    for (const user of users1Day) {
        let saved = false;
        for (const sub of user.subscriptions) {
            if (sub.status !== 'active') continue;
            if (sub.endDate < oneDayStart || sub.endDate > oneDayEnd) continue;
            if ((sub.reminderLevel || 0) >= 2) continue;
            
            try {
                const catKey = getCategoryKeyFromSub(sub);
                const text = `⏰ **FINAL NOTICE — EXPIRES TOMORROW!**\n\nYour ${sub.category} (${sub.plan}) ends **tomorrow** (${sub.endDate.toLocaleDateString()}).\n\n⚠️ This is your **final warning**. Once expired, you'll be removed from the channel and lose access to all content.\n\n💎 **Don't just renew — upgrade!** Longer plans = bigger savings.\n\n👇 This is your last chance 👇`;
                
                await bot.api.sendMessage(user.telegramId, text, {
                    parse_mode: "Markdown",
                    reply_markup: psychologyRenewMenu(catKey, sub.plan)
                });
                
                sub.reminderLevel = 2;
                saved = true;
                console.log(`⏰ 1-day (tomorrow) reminder sent to ${user.telegramId}`);
            } catch (err) {
                if (err.description === "Forbidden: bot was blocked by the user") {
                    console.log(`User ${user.telegramId} blocked bot. Marking inactive.`);
                    user.isActive = false;
                    saved = true;
                } else {
                    console.error(`Failed 1-day remind ${user.telegramId}:`, err.message);
                }
            }
        }
        if (saved) await user.save();
    }
}

cron.schedule('0 9 * * *', runReminders);

cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const users = await User.find({
        isActive: { $ne: false },
        subscriptions: {
            $elemMatch: {
                status: 'active',
                endDate: { $lt: now }
            }
        }
    });

    for (const user of users) {
        let saved = false;
        
        for (const sub of user.subscriptions) {
            if (sub.status !== 'active' || sub.endDate >= now) continue;
            
            sub.status = 'expired';
            sub.reminderLevel = 3;
            saved = true;
            
            await banUserFromChannel(user.telegramId);
            await notifyAdminRemoval(user, sub);

            try {
                const expiryText = `⏰ **ACCESS REVOKED**\n\nYour ${sub.category} subscription has expired. You've been removed from the VIP channel.\n\n😢 You're missing out! Fresh content drops daily and thousands of members are enjoying it right now.\n\n🔥 **Come back stronger:** Choose any plan below and rejoin instantly 👇`;
                
                await bot.api.sendMessage(user.telegramId, expiryText, {
                    parse_mode: "Markdown",
                    reply_markup: mainMenu
                });
            } catch (err) {
                if (err.description === "Forbidden: bot was blocked by the user") {
                    console.log(`User ${user.telegramId} blocked bot. Marking inactive.`);
                    user.isActive = false;
                } else {
                    console.error(`Failed to notify expiry ${user.telegramId}:`, err.message);
                }
            }
        }
        
        if (saved) await user.save();
    }
});

cron.schedule('0 14 */3 * *', async () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const users = await User.find({
        isActive: { $ne: false },
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
            if (e.description === "Forbidden: bot was blocked by the user") {
                console.log(`User ${user.telegramId} blocked bot on win-back. Marking inactive.`);
                await User.updateOne({ telegramId: user.telegramId }, { isActive: false });
            }
        }
    }
});

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================
bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    const desc = e?.description || "";
    
    if (
        desc === "Forbidden: bot was blocked by the user" ||
        desc.includes("query is too old") ||
        desc.includes("message is not modified")
    ) {
        return; 
    }

    console.error(`Error while handling update ${ctx?.update?.update_id}:`);
    if (desc) console.error("Telegram API Error:", desc);
    else console.error("Unknown Error:", e?.message || e);
});

// ==========================================
// START
// ==========================================
const PORT = process.env.PORT || 3011;
app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));
bot.start({ onStart: (botInfo) => console.log(`🤖 Bot @${botInfo.username} started!`) });