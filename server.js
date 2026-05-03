import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
import { Zalo } from "zca-js";
import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import mongoose from 'mongoose';
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import PQueue from 'p-queue';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// --- KẾT NỐI MONGODB ---
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log("🍃 Đã kết nối MongoDB thành công!"))
        .catch(err => console.error("❌ Lỗi kết nối MongoDB:", err.message));
}

const statsSchema = new mongoose.Schema({
    _id: { type: String, default: 'global' },
    totalLookups: { type: Number, default: 0 },
    totalScammers: { type: Number, default: 0 },
    cacheHits: { type: Number, default: 0 },
    freshScans: { type: Number, default: 0 }
});
const Stats = mongoose.model('Stats', statsSchema);

const lookupSchema = new mongoose.Schema({
    phone: { type: String, required: true, index: true },
    zalo: Object,
    facebook: Object,
    instagram: Object,
    telegram: Object,
    checkscam: Object,
    carrier: Object,
    createdAt: { type: Date, default: Date.now }
});
const Lookup = mongoose.model('Lookup', lookupSchema);

const puppeteerQueue = new PQueue({ concurrency: 1 });
function getQueueStatus() {
    return {
        size: puppeteerQueue.size,
        pending: puppeteerQueue.pending,
        total: puppeteerQueue.size + puppeteerQueue.pending
    };
}
function enqueueJob(fn) {
    return puppeteerQueue.add(fn);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let zaloApi = null;
const ZALO_IMEI = "ee2abaac-2ab3-4917-86c2-e8b6af912369-7c73ef5b8d3235ae0606f2e84e457ff5";
const ZALO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

let tgClient = null;
const tgApiId = parseInt(process.env.TG_API_ID);
const tgApiHash = process.env.TG_API_HASH;
const tgSession = new StringSession(process.env.TG_SESSION || "");

if (tgApiId && tgApiHash && process.env.TG_SESSION) {
    tgClient = new TelegramClient(tgSession, tgApiId, tgApiHash, { connectionRetries: 5 });
    tgClient.connect().then(() => console.log("✈️ Telegram MTProto đã sẵn sàng!")).catch(err => console.error("❌ Lỗi Telegram:", err.message));
}

const USE_PROXY = process.env.USE_PROXY === 'true' || false;
const PROXY_LIST = [
    "http://134.209.29.120:3128",
    "http://128.199.202.122:8080",
    "http://8.219.97.248:80"
];
let proxyIndex = 0;
let cookieAlerts = { zalo: false, instagram: false };

// Flags tối ưu RAM cho gói Free của Render
const LOW_MEMORY_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--single-process',
    '--no-zygote',
    '--disable-gpu',
    '--disable-canvas-aa',
    '--disable-2d-canvas-clip-aa',
    '--disable-gl-drawing-for-tests',
    '--disable-extensions',
    '--no-first-run',
    '--js-flags="--max-old-space-size=256"'
];

function getNextProxy() {
    const proxy = PROXY_LIST[proxyIndex];
    proxyIndex = (proxyIndex + 1) % PROXY_LIST.length;
    return proxy;
}

async function initZalo() {
    try {
        const zalo = new Zalo({ logging: true });
        let cookie;
        if (process.env.ZALO_COOKIE) {
            cookie = JSON.parse(process.env.ZALO_COOKIE);
        } else {
            cookie = JSON.parse(fs.readFileSync("./cookie.json", "utf-8"));
        }
        zaloApi = await zalo.login({
            cookie: cookie,
            imei: ZALO_IMEI,
            userAgent: ZALO_UA
        });
        console.log("✅ Zalo Session đã sẵn sàng!");
    } catch (error) {
        console.error("❌ Lỗi khởi tạo Zalo:", error.message);
    }
}

async function checkFacebook(phone) {
    let attempts = 0;
    const maxAttempts = USE_PROXY ? PROXY_LIST.length : 1;
    while (attempts < maxAttempts) {
        const proxy = USE_PROXY ? getNextProxy() : null;
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [...LOW_MEMORY_ARGS, ...(proxy ? [`--proxy-server=${proxy}`] : [])]
        });
        try {
            const page = await browser.newPage();
            // Chặn ảnh/css để tiết kiệm RAM và tốc độ
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font'].includes(req.resourceType())) req.abort();
                else req.continue();
            });

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
            await page.goto('https://www.facebook.com/login/identify/?ctx=recover', { waitUntil: 'networkidle2', timeout: 20000 });
            await page.waitForSelector('input[type="text"]');
            await page.type('input[type="text"]', phone);
            await page.keyboard.press('Enter');
            await page.waitForSelector('div[role="button"] image', { timeout: 10000 }).catch(() => { });
            const resultElements = await page.$$('div[role="button"]');
            const accounts = [];
            for (let el of resultElements) {
                const name = await el.evaluate(e => e.querySelector('div > div > div:nth-child(2) div')?.textContent || null);
                const avatar = await el.evaluate(e => e.querySelector('image')?.getAttribute('xlink:href') || e.querySelector('image')?.getAttribute('href') || null);
                if (name && avatar && name !== "Tìm kiếm" && !name.includes("Thử lại")) {
                    const isPhoneNumber = /^\+?\d{8,15}$/.test(name.replace(/[\s.-]/g, ''));
                    if (!isPhoneNumber) accounts.push({ name, profile_pic_url: avatar, platform: "FACEBOOK" });
                }
            }
            await browser.close();
            return { success: true, found: accounts.length > 0, accounts };
        } catch (error) {
            await browser.close();
            attempts++;
        }
    }
    return { success: false, found: false, error: "Lỗi Facebook (RAM/Timeout)" };
}

async function checkInstagram(phone) {
    let attempts = 0;
    const maxAttempts = USE_PROXY ? PROXY_LIST.length : 1;
    while (attempts < maxAttempts) {
        const proxy = USE_PROXY ? getNextProxy() : null;
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [...LOW_MEMORY_ARGS, ...(proxy ? [`--proxy-server=${proxy}`] : [])],
            userDataDir: './ig_profile'
        });
        try {
            const page = await browser.newPage();
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font'].includes(req.resourceType())) req.abort();
                else req.continue();
            });

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
            await page.goto('https://www.instagram.com/accounts/password/reset/', { waitUntil: 'networkidle2', timeout: 20000 });
            await page.waitForSelector('input');
            await page.type('input', phone);
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 4000));
            const content = await page.content();
            const exists = content.includes("We sent a link") || content.includes("Sent") || content.includes("Chúng tôi đã gửi");
            const notFound = content.includes("No users found") || content.includes("Không tìm thấy người dùng");
            await browser.close();
            if (exists) return { success: true, found: true, message: "Có tài khoản Instagram gắn với số này." };
            if (notFound) return { success: true, found: false, message: "Không tìm thấy tài khoản Instagram." };
            return { success: false, error: "Bị chặn/Captcha" };
        } catch (error) {
            await browser.close();
            attempts++;
        }
    }
    return { error: "Lỗi Instagram (RAM/Timeout)" };
}

function checkCarrier(phone) {
    const prefix = phone.substring(0, 3);
    const mapping = {
        '032': 'Viettel', '033': 'Viettel', '034': 'Viettel', '035': 'Viettel', 
        '036': 'Viettel', '037': 'Viettel', '038': 'Viettel', '039': 'Viettel',
        '086': 'Viettel', '096': 'Viettel', '097': 'Viettel', '098': 'Viettel',
        '081': 'Vinaphone', '082': 'Vinaphone', '083': 'Vinaphone', '084': 'Vinaphone', 
        '085': 'Vinaphone', '088': 'Vinaphone', '091': 'Vinaphone', '094': 'Vinaphone',
        '070': 'Mobifone', '076': 'Mobifone', '077': 'Mobifone', '078': 'Mobifone', 
        '079': 'Mobifone', '089': 'Mobifone', '090': 'Mobifone', '093': 'Mobifone',
        '052': 'Vietnamobile', '056': 'Vietnamobile', '058': 'Vietnamobile', '092': 'Vietnamobile',
        '059': 'Gmobile', '099': 'Gmobile'
    };
    return { success: true, network: mapping[prefix] || 'Không xác định', type: 'Mobile' };
}

async function checkCheckScam(phone) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
    });
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36');
        await page.goto(`https://checkscam.vn/?qh_ss=${phone}`, { waitUntil: 'networkidle2', timeout: 30000 });
        const data = await page.evaluate(() => {
            const catSection = document.querySelector('#cat .pst');
            if (catSection && catSection.querySelectorAll('div.ct').length > 0) return { isScammer: true, verdict: '🚨 CÓ BÁO CÁO LỪA ĐẢO' };
            return { isScammer: false, verdict: '✅ CHƯA CÓ BÁO CÁO LỪA ĐẢO' };
        });
        await browser.close();
        return { success: true, ...data };
    } catch (error) {
        await browser.close();
        return { error: "Lỗi CheckScam" };
    }
}

async function checkTelegram(phone) {
    if (!tgClient || !tgClient.connected) return { error: "Chưa cấu hình Telegram MTProto" };
    let formattedPhone = phone.startsWith("0") ? "+84" + phone.slice(1) : (phone.startsWith("+") ? phone : "+" + phone);
    try {
        const result = await tgClient.invoke(new Api.contacts.ImportContacts({
            contacts: [new Api.InputPhoneContact({ clientId: BigInt(Date.now()), phone: formattedPhone, firstName: "Search", lastName: phone })]
        }));

        if (result.users && result.users.length > 0) {
            const user = result.users[0];
            
            // Lấy thông tin đầy đủ (Bio/About)
            const fullUser = await tgClient.invoke(new Api.users.GetFullUser({ id: user.id }));
            const about = fullUser.fullUser?.about || "Không có";
            
            await tgClient.invoke(new Api.contacts.DeleteContacts({ id: [user.id] }));
            
            return {
                success: true,
                found: true,
                name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
                username: user.username ? `@${user.username}` : "Không có",
                id: user.id.toString(),
                phone: user.phone,
                about: about,
                isPremium: user.premium || false,
                isBot: user.bot || false,
                status: user.status?._ || "N/A"
            };
        }
        return { success: true, found: false };
    } catch (error) { 
        console.error("Lỗi Telegram Detail:", error.message);
        return { error: "Lỗi Telegram" }; 
    }
}

async function checkCookieHealth() {
    if (zaloApi) {
        try { await zaloApi.findUser("0978497375"); } catch (err) {
            if (!cookieAlerts.zalo) {
                fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=🚨 *Zalo Cookie Expired*&parse_mode=Markdown`).catch(()=>{});
                cookieAlerts.zalo = true;
            }
        }
    }
}
setInterval(checkCookieHealth, 5 * 60 * 1000);

async function sendTelegramMessage(ip, phone, result) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const msg = `🔍 SĐT: ${phone}\n🌐 IP: ${ip}\n🔵 Zalo: ${result.zalo?.zalo_name || "Không thấy"}\n🔵 FB: ${result.facebook?.found ? "✅ Có" : "❌ Không"}\n🟣 IG: ${result.instagram?.found ? "✅ Có" : "❌ Không"}\n✈️ TG: ${result.telegram?.found ? "✅ Có" : "❌ Không"}\n🔎 CheckScam: ${result.checkscam?.verdict || "N/A"}`;
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}`).catch(()=>{});
}

app.get('/api/clear-cache', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: "Thiếu sđt" });
    const result = await Lookup.deleteMany({ phone: phone.trim() });
    console.log(`🗑️ Clear Cache: ${phone.trim()} - Deleted: ${result.deletedCount}`);
    res.json({ success: true, deletedCount: result.deletedCount });
});

app.get('/api/stats', async (req, res) => {
    const total = await Lookup.countDocuments();
    res.json({ database: { totalLookups: total }, queue: getQueueStatus() });
});

app.get('/api/check-all', async (req, res) => {
    const { phone } = req.query;
    if (!phone || !/^0\d{9}$/.test(phone)) return res.status(400).json({ success: false, error: "SĐT không hợp lệ" });
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    try {
        console.log(`🔍 Tra cứu: ${phone}`);
        let cached = await Lookup.findOne({ phone: phone.trim() });
        
        // Kiểm tra cache (1 tiếng)
        if (cached && (Date.now() - new Date(cached.createdAt).getTime() < 3600000)) {
            return res.json({ ...cached.toObject(), fromCache: true });
        }
        
        if (getQueueStatus().total >= 5) {
            console.log(`⏳ Hàng đợi đầy: ${phone}`);
            return res.status(202).json({ status: 'queued', message: "Hàng đợi đầy, vui lòng thử lại sau." });
        }

        console.log(`🚀 Bắt đầu quét mới: ${phone}`);
        const result = await enqueueJob(async () => {
            const [zalo, fb, ig, tg, cs, carrier] = await Promise.allSettled([
                zaloApi ? zaloApi.findUser(phone) : Promise.reject('No login'),
                checkFacebook(phone),
                checkInstagram(phone),
                checkTelegram(phone),
                checkCheckScam(phone),
                Promise.resolve(checkCarrier(phone))
            ]);
            
            const data = {
                phone: phone.trim(),
                zalo: zalo.status==='fulfilled'?zalo.value:{error:zalo.reason},
                facebook: fb.status==='fulfilled'?fb.value:{error:fb.reason},
                instagram: ig.status==='fulfilled'?ig.value:{error:ig.reason},
                telegram: tg.status==='fulfilled'?tg.value:{error:tg.reason},
                checkscam: cs.status==='fulfilled'?cs.value:{error:cs.reason},
                carrier: carrier.status==='fulfilled'?carrier.value:{error:carrier.reason},
                createdAt: new Date()
            };
            return data;
        });

        await Lookup.findOneAndUpdate({ phone: phone.trim() }, { $set: result }, { upsert: true });
        console.log(`✅ Hoàn tất tra cứu: ${phone}`);
        sendTelegramMessage(clientIp, phone, result);
        res.json(result);
    } catch (e) { 
        console.error(`❌ Lỗi API (${phone}):`, e.message);
        res.status(500).json({ error: "System Error" }); 
    }
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server on ${PORT}`);
    await initZalo();
});
