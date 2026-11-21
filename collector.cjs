const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const path = require('node:path');

const pause = async (rl, message) => { await rl.question(message); };
function extract(text, names) {
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([^:]{2,45}):\s*(.+)$/);
    if (match && names.some(n => match[1].trim().toLowerCase() === n)) return match[2].trim();
  }
  return null;
}
function numeric(value) { if (!value) return null; const s=String(value).replace(/[^\d]/g, ''); return s ? Number(s) : null; }
function normalize(raw, listing) {
  let lines=raw.text || '';
  let mileage=extract(lines,['пробег']);
  let owner=extract(lines,['владельцев по птс','владельцев','количество владельцев']);
  let climate=extract(lines,['климатическая установка','климат-контроль','климат контроль']);
  let equipment=lines.match(/(?:^|\n)\s*(климат-контроль|климат контроль)\s*(?:\n|$)/i);
  let c=climate ? (/нет|отсутств/i.test(climate)?false:/климат/i.test(climate)?true:null) : equipment?true:null;
  let title=raw.title || listing.title || null;
  let yearText=extract(lines,['год выпуска','год']);
  let yearMatch=String(yearText||title||'').match(/(?:19|20)\d{2}/);
  return {title, make:extract(lines,['марка','марка автомобиля']), model:extract(lines,['модель','модель автомобиля']), generation:extract(lines,['поколение']), year:yearMatch?Number(yearMatch[0]):null, price: numeric(raw.price) ?? listing.price ?? null,
    owners: owner, mileage: numeric(mileage), drive:extract(lines,['привод']), gearbox:extract(lines,['коробка передач','коробка','кпп']),
    climate:c, color:extract(lines,['цвет']), photo:raw.photo||listing.photo||null,url:listing.url};
}
function validUrl(value) { try { let u=new URL(value); return u.protocol==='https:' && (u.hostname==='avito.ru'||u.hostname.endsWith('.avito.ru')); } catch { return false; } }
async function main() {
  const rl=readline.createInterface({input:stdin,output:stdout});
  let context;
  try {
    context=await chromium.launchPersistentContext(path.join(__dirname,'.avito-profile'),{channel:'chrome',headless:false,viewport:{width:1280,height:900}});
    let page=context.pages()[0] || await context.newPage();
    await page.goto('https://www.avito.ru/',{waitUntil:'domcontentloaded',timeout:60000});
    console.log('\nОткрылся отдельный браузер. Войдите в свой аккаунт Авито самостоятельно, затем настройте поиск автомобилей и фильтры.');
    await pause(rl,'Когда результаты поиска откроются, нажмите Enter здесь... ');
    let searchUrl=page.url();
    if (!validUrl(searchUrl) || !/\/avtomobili(?:\/|\?|$)/i.test(new URL(searchUrl).pathname)) throw Error('Откройте страницу результатов категории «Автомобили» на avito.ru.');
    let max=Number(await rl.question('Сколько объявлений собрать (1–100): '));
    if (!Number.isInteger(max)||max<1||max>100) throw Error('Количество должно быть от 1 до 100.');
    let listings=[];let seen=new Set();
    for(let n=1;n<=Math.ceil(max/20)+2 && listings.length<max;n++) {
      let u=new URL(searchUrl);if(n>1)u.searchParams.set('p',String(n));
      await page.goto(u.href,{waitUntil:'domcontentloaded',timeout:60000});
      await page.waitForTimeout(1800);
      const found=await page.locator('[data-marker="item"]').evaluateAll(nodes=>nodes.map(el=>{let a=el.querySelector('a[href*="_"],a[itemprop="url"]');let img=el.querySelector('img');let price=el.querySelector('[itemprop="price"]');return {url:a?.href,title:a?.innerText?.trim(),photo:img?.currentSrc||img?.src,price:price?.getAttribute('content')?Number(price.getAttribute('content')):null}}));
      if(!found.length){console.log(`На странице ${n} объявления не обнаружены. Проверьте страницу: Авито мог показать проверку доступа или изменить разметку.`);break;}
      let before=listings.length;for(const item of found){if(validUrl(item.url)&&!seen.has(item.url)){seen.add(item.url);listings.push(item);if(listings.length>=max)break;}}
      console.log(`Найдено ссылок: ${listings.length}`);if(listings.length===before)break;
    }
    if(!listings.length)throw Error('Не найдено ни одного объявления. Файл не создан.');
    let results=[];
    for(const item of listings){
      try {
        await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(1000);
        let raw=await page.evaluate(()=>({title:document.querySelector('h1')?.innerText?.trim(),price:document.querySelector('[itemprop="price"]')?.getAttribute('content'),photo:document.querySelector('meta[property="og:image"]')?.content,text:document.body.innerText}));
        if(/доступ ограничен|подтвердите, что вы не робот|подозрительн.{0,15}активност|captcha/i.test(raw.text)){console.log('Авито запросил проверку. Сбор остановлен; пройдите её самостоятельно в браузере и запустите сбор снова.');break;}
        results.push(normalize(raw,item));console.log(`Обработано ${results.length}/${listings.length}: ${results.at(-1).title}`);
      } catch(e){console.warn('Пропущено объявление:',item.url,e.message);}
    }
    if(!results.length) throw Error('Данные объявлений не получены.');
    const out=path.join(__dirname,'avito-results.json');await fs.writeFile(out,JSON.stringify(results,null,2),'utf8');
    console.log(`\nГотово: ${out}\nЗагрузите файл на сайте через кнопку «Загрузить JSON». Неизвестные поля оставлены пустыми.`);
  } finally {rl.close();if(context)await context.close();}
}
if(require.main===module) main().catch(e=>{console.error('Ошибка:',e.message);process.exitCode=1});
module.exports={normalize,validUrl};
