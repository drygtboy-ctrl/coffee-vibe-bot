import express from 'express';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import crypto from 'node:crypto';

const { ADMIN_CHAT_ID, PORT = 10000, BARISTA_NAME = 'Марк', PROMO_CODE = 'ЗЕРНО10', PROMO_PCT = 10 } = process.env;
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN; // подойдёт любое из двух имён
// На Render публичный адрес подставляется сам (RENDER_EXTERNAL_URL). Локально можно ничего не задавать:
// бот заработает в режиме long polling, но без кнопки Web App (ей нужен https-адрес, например туннель).
const BASE = (process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const WEBHOOK = BASE.startsWith('https://');
if (!BOT_TOKEN) {
  console.error('Нужна переменная BOT_TOKEN (токен от @BotFather)');
  process.exit(1);
}
const SECRET = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32); // защита вебхука

const MENU = [
  { id: 'esp', name: 'Эспрессо', price: 150, cat: 'Кофе' },
  { id: 'ame', name: 'Американо', price: 170, cat: 'Кофе' },
  { id: 'cap', name: 'Капучино', price: 220, cat: 'Кофе' },
  { id: 'lat', name: 'Латте', price: 240, cat: 'Кофе' },
  { id: 'fw', name: 'Флэт уайт', price: 250, cat: 'Кофе' },
  { id: 'mat', name: 'Матча-латте', price: 280, cat: 'Кофе' },
  { id: 'cro', name: 'Круассан', price: 160, cat: 'Десерты' },
  { id: 'chz', name: 'Чизкейк', price: 260, cat: 'Десерты' },
  { id: 'brw', name: 'Брауни', price: 190, cat: 'Десерты' },
];
const orders = []; // в памяти: при перезапуске Render очищается (для продакшена нужна база данных)

const bot = new Bot(BOT_TOKEN);
const menuKb = () => (WEBHOOK ? new InlineKeyboard().webApp('☕ Открыть меню', BASE) : undefined);

// ---------- Локальный ИИ-бариста: никаких внешних API, всё работает на ключевых словах ----------
const INFO = { hours: 'ежедневно с 8:00 до 20:00', address: 'ул. Кофейная, 12' }; // замените на свои данные
const CODE = PROMO_CODE.toLowerCase().replace(/ё/g, 'е');
const PCT = Number(PROMO_PCT) || 10;
const promo = new Set(); // чаты, где гость назвал кодовое слово
const last = new Map(); // chatId -> позиция меню, о которой говорили последней

const DESC = {
  esp: 'Плотный насыщенный шот — для тех, кто любит покрепче.',
  ame: 'Эспрессо с горячей водой: мягче и дольше пьётся, удобно с ноутбуком.',
  cap: 'Классика: эспрессо, молоко и воздушная пенка.',
  lat: 'Нежный и молочный, самый «домашний» вариант.',
  fw: 'Двойной эспрессо с бархатным молоком — насыщеннее латте.',
  mat: 'Зелёная матча с молоком — мягкая бодрость без горечи эспрессо.',
  cro: 'Слоёный и хрустящий, свежая выпечка.',
  chz: 'Нежный сливочный чизкейк, отлично с американо.',
  brw: 'Шоколадный брауни с плотной серединой, идеален к латте.',
};
const PAIR = { esp: 'brw', ame: 'chz', cap: 'cro', lat: 'brw', fw: 'cro', mat: 'chz', cro: 'cap', chz: 'ame', brw: 'lat' };
const ITEM_RE = [['mat', /матч/], ['fw', /флэт|флет|флат/], ['esp', /эспрессо|espresso/], ['ame', /американо/], ['cap', /капуч/], ['lat', /латте|лате(?![а-я])/], ['cro', /круассан/], ['chz', /чизкейк|чизкек/], ['brw', /брауни/]];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const get = (id) => MENU.find((m) => m.id === id);
const list = (cat) => MENU.filter((m) => m.cat === cat).map((m) => m.name + ' — ' + m.price + ' ₽').join('\n');
const both = () => '☕ Кофе:\n' + list('Кофе') + '\n\n🥐 Десерты:\n' + list('Десерты');

function reply(chatId, raw) {
  const t = raw.toLowerCase().replace(/ё/g, 'е');
  const has = (re) => re.test(t);
  const found = ITEM_RE.find(([, re]) => re.test(t))?.[0];
  const hi = has(/привет|здравств|добрый|доброе|добрая|хай|hello/) ? 'Привет! ' : '';
  const out = (text, btn = false) => ({ text, btn: btn && WEBHOOK }); // btn — приложить кнопку «Открыть меню»
  if (found) last.set(chatId, found);

  if (CODE && t.split(/[^a-zа-я0-9]+/).includes(CODE)) {
    promo.add(chatId);
    return out('Кодовое слово принято! 🎉 Скидка ' + PCT + '% на ваш заказ — применится автоматически, когда оформите его в меню.', true);
  }
  if (has(/спасибо|благодар|thanks/)) return out(pick(['Всегда пожалуйста! Заходите — сварю лучший кофе ☕', 'Рад помочь! Хорошего дня ☀️']));
  if (has(/пока|до свидан|до встречи|всего доброго|удачи/)) return out('До встречи в «Зерне»! ☕');
  if (has(/режим работы|график|работаете|открыты|открыто|до скольки|во сколько закр|адрес|где наход|как добраться|как найти/))
    return out('Мы работаем ' + INFO.hours + '. Адрес: ' + INFO.address + '. Ждём вас! ☕');
  if (has(/wi-?fi|вайфай|интернет|розетк|коворкинг|поработать|ноутбук/))
    return out('Да, у нас есть Wi-Fi и розетки у каждого стола — можно спокойно работать. Пароль подскажет бариста 😉');
  if (has(/скидк|промо|акци|дорого|дешев|кодов|подешевле/))
    return out(CODE ? 'Раз уж спросили — держите секрет 🤫 Напишите кодовое слово ' + PROMO_CODE + ', и скидка ' + PCT + '% на заказ ваша.' : 'Акций пока нет, зато зерно свежайшее ☕');
  if (has(/цен|сколько стоит|сколько стоят|стоимост|прайс|почем|сколько это/)) {
    const id = found || (has(/сколько стоит|почем|а сколько/) && last.get(chatId));
    return out(id ? get(id).name + ' стоит ' + get(id).price + ' ₽. ' + DESC[id] + ' Оформим? 👇' : both(), true);
  }
  if (has(/посоветуй|порекомендуй|что взять|что выбрать|что попробовать|не знаю что|на твой вкус|на ваш вкус|крепк|бодр|сладк|мягк|нежн|не горьк|без кофе|не кофе/)) {
    const [a, b] = has(/крепк|бодр/) ? ['fw', 'brw'] : has(/сладк/) ? ['lat', 'brw'] : has(/мягк|нежн|не горьк/) ? ['cap', 'cro'] : has(/без кофе|не кофе/) ? ['mat', 'chz'] : ['cap', 'cro'];
    last.set(chatId, a);
    return out(hi + 'Мой выбор — ' + get(a).name.toLowerCase() + ' (' + get(a).price + ' ₽) и ' + get(b).name.toLowerCase() + ' (' + get(b).price + ' ₽). ' + DESC[a], true);
  }
  if (has(/заказ|оформ|хочу|возьму|запиши|купить|забронир/))
    return out((found ? get(found).name + ' — отличный выбор! ' : '') + (WEBHOOK ? 'Нажмите кнопку ниже, выберите позиции и время визита — заказ сразу уйдёт баристе 👇' : 'Оформление заказа заработает, когда бот будет запущен на сервере с https-адресом (например, на Render).'), true);
  if (has(/меню|ассортимент|что есть|что у вас|чем угостите|кофе|десерт|выпечк/)) {
    const d = has(/десерт|выпечк/), c = has(/кофе/);
    return out(hi + (d && !c ? '🥐 Десерты:\n' + list('Десерты') : c && !d && !has(/меню/) ? '☕ Кофе:\n' + list('Кофе') : both()), true);
  }
  if (found) {
    const p = get(PAIR[found]);
    return out(hi + get(found).name + ' — ' + get(found).price + ' ₽. ' + DESC[found] + ' К нему отлично пойдёт ' + p.name.toLowerCase() + ' (' + p.price + ' ₽).', true);
  }
  if (hi) return out('Привет! Я ' + BARISTA_NAME + ', бариста «Зерно» ☕ Подскажу по меню и ценам, посоветую напиток и помогу оформить заказ. Что вам по вкусу?', true);
  return out(pick(['Хм, тут я не эксперт 😅 Зато всё знаю про кофе: спросите про меню, цены, скидки или что взять.', 'Не совсем понял. Могу показать меню, назвать цены или подсказать напиток по вкусу ☕']), true);
}

bot.command('start', (ctx) =>
  ctx.reply('Привет! Я ' + BARISTA_NAME + ', бариста «Зерно» ☕ Спросите про меню, цены или напиток по вкусу' + (WEBHOOK ? ' — или откройте меню кнопкой ниже и оформите заказ.' : '.'), { reply_markup: menuKb() }),
);
bot.on('message:text', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  await new Promise((r) => setTimeout(r, 700)); // небольшая пауза, как будто бариста печатает
  const { text, btn } = reply(ctx.chat.id, ctx.message.text);
  await ctx.reply(text, btn ? { reply_markup: menuKb() } : undefined);
});
bot.catch((e) => console.error('Bot error:', e.error ?? e));

// Проверка подписи initData: заказ принимается только из настоящего Telegram Web App.
function verifyInitData(initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  p.delete('hash');
  if (!hash) return null;
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

// Страница Web App (бывший index.html). Внутри нет обратных кавычек и «долларов со скобками» — иначе String.raw сломается.
const PAGE = String.raw`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Зерно — меню</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#fff);--tx:var(--tg-theme-text-color,#1c2420);--mut:var(--tg-theme-hint-color,#6b756f);--card:var(--tg-theme-secondary-bg-color,#f1f3f0);--acc:var(--tg-theme-button-color,#2d6a4f);--on:var(--tg-theme-button-text-color,#fff)}
*{box-sizing:border-box}
body{margin:0;padding:16px 16px 96px;background:var(--bg);color:var(--tx);font:15px/1.4 system-ui,-apple-system,sans-serif}
h1{font-size:22px;margin:4px 0 2px}h2{font-size:15px;color:var(--mut);font-weight:600;margin:22px 0 8px}
.sub{color:var(--mut);margin:0}
.row{display:flex;align-items:center;gap:12px;background:var(--card);border-radius:16px;padding:12px 14px;margin-bottom:8px}
.row b{flex:1;font-weight:500}.row .p{color:var(--mut)}
.ctl{display:flex;align-items:center;gap:10px}
.ctl button{width:32px;height:32px;border:0;border-radius:50%;background:var(--acc);color:var(--on);font-size:18px;line-height:1}
.ctl button:disabled{opacity:.3}.ctl i{min-width:16px;text-align:center;font-style:normal}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips button{border:1px solid var(--mut);border-radius:999px;background:none;color:var(--tx);padding:8px 14px;font-size:14px}
.chips button.on{background:var(--acc);border-color:var(--acc);color:var(--on)}
</style></head>
<body>
<h1>Зерно</h1><p class="sub">Выберите напитки и время визита</p>
<div id="menu"></div>
<h2>Когда зайдёте?</h2>
<div class="chips" id="time"></div>
<script>
const tg=Telegram.WebApp;tg.ready();tg.expand();
const TIMES=['Через 10 мин','Через 30 мин','Через час','К 18:00'];
const cart={};let menu=[],time=TIMES[0];
const rub=n=>n.toLocaleString('ru-RU')+' ₽';
const $=s=>document.querySelector(s);
const total=()=>menu.reduce((s,m)=>s+m.price*(cart[m.id]||0),0);
function sync(){
  menu.forEach(m=>{const q=cart[m.id]||0;$('[data-q="'+m.id+'"]').textContent=q;$('[data-d="'+m.id+'"]').disabled=!q});
  const t=total();
  if(t){tg.MainButton.setText('Заказать · '+rub(t));tg.MainButton.show()}else tg.MainButton.hide();
}
fetch('/api/menu').then(r=>r.json()).then(data=>{
  menu=data;let cat='',out='';
  menu.forEach(m=>{
    if(m.cat!==cat){cat=m.cat;out+='<h2>'+cat+'</h2>'}
    out+='<div class="row"><b>'+m.name+'</b><span class="p">'+rub(m.price)+'</span><div class="ctl"><button data-d="'+m.id+'" aria-label="Убрать">−</button><i data-q="'+m.id+'">0</i><button data-a="'+m.id+'" aria-label="Добавить">+</button></div></div>';
  });
  $('#menu').innerHTML=out;sync();
});
$('#menu').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  const id=b.dataset.a||b.dataset.d;
  cart[id]=Math.max(0,(cart[id]||0)+(b.dataset.a?1:-1));
  tg.HapticFeedback.selectionChanged();sync();
});
const drawTime=()=>{$('#time').innerHTML=TIMES.map(t=>'<button class="'+(t===time?'on':'')+'">'+t+'</button>').join('')};
$('#time').addEventListener('click',e=>{if(e.target.tagName==='BUTTON'){time=e.target.textContent;drawTime()}});
drawTime();
tg.MainButton.onClick(async()=>{
  tg.MainButton.showProgress();
  try{
    const r=await fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:tg.initData,items:cart,time:time})});
    if(!r.ok)throw new Error(r.status);
    tg.HapticFeedback.notificationOccurred('success');
    tg.close();
  }catch(err){
    tg.MainButton.hideProgress();
    tg.showAlert('Не удалось отправить заказ. Попробуйте ещё раз.');
  }
});
</script>
</body></html>`;

const app = express();
app.use(express.json());
app.get('/', (_req, res) => res.type('html').send(PAGE));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/api/menu', (_req, res) => res.json(MENU));

app.post('/api/order', async (req, res) => {
  const user = verifyInitData(String(req.body?.initData ?? ''));
  if (!user) return res.sendStatus(401);
  const items = {};
  let total = 0;
  for (const m of MENU) { // цены только серверные, количеству не доверяем
    const q = Math.min(20, Math.floor(Number(req.body.items?.[m.id]) || 0));
    if (q > 0) { items[m.id] = q; total += m.price * q; }
  }
  if (!total) return res.sendStatus(400);
  const disc = promo.has(user.id) ? PCT : 0; // в личном чате id чата = id пользователя
  total = Math.round(total * (1 - disc / 100));
  const time = String(req.body.time ?? 'Сразу').slice(0, 30);
  const order = { id: 1000 + orders.length + 1, user, items, total, time, status: 'new', at: Date.now() };
  orders.push(order);
  const lines = Object.entries(items).map(([id, q]) => '• ' + MENU.find((m) => m.id === id).name + ' × ' + q).join('\n');
  await bot.api.sendMessage(user.id, 'Заказ №' + order.id + ' принят ✅\n' + lines + '\nИтого: ' + total + ' ₽' + (disc ? ' (скидка −' + disc + '%)' : '') + '\nВремя: ' + time.toLowerCase()).catch(console.error);
  if (ADMIN_CHAT_ID) await bot.api.sendMessage(ADMIN_CHAT_ID, '🆕 Заказ №' + order.id + ' от ' + user.first_name + '\n' + lines + '\nИтого: ' + total + ' ₽' + (disc ? ' (скидка −' + disc + '%)' : '') + ' · ' + time).catch(console.error);
  res.json({ ok: true, id: order.id });
});

// Вебхук вместо long polling: входящий запрос от Telegram будит бесплатный сервис Render.
// onTimeout 'return' — если ответ задержится, Telegram получит 200 через 9 с и не будет слать повторы.
app.post('/telegram', webhookCallback(bot, 'express', { secretToken: SECRET, onTimeout: 'return', timeoutMilliseconds: 9000 }));

app.listen(PORT, '0.0.0.0', () => console.log('Сервер запущен на порту ' + PORT));
await bot.init();
if (WEBHOOK) {
  await bot.api.setWebhook(BASE + '/telegram', { secret_token: SECRET });
  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Меню', web_app: { url: BASE } } });
  console.log('Бот @' + bot.botInfo.username + ' подключён через вебхук: ' + BASE);
} else {
  await bot.api.deleteWebhook(); // long polling не работает, пока у бота установлен вебхук
  bot.start();
  console.log('Бот @' + bot.botInfo.username + ' запущен локально (long polling), кнопка Web App отключена');
}
