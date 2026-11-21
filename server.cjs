const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { normalize, validUrl } = require('./collector.cjs');
const HOST='127.0.0.1', PORT=39271, BASE=`http://${HOST}:${PORT}`;
const token=crypto.randomBytes(32).toString('hex');
let context, busy=false;
function parseFilters(input){
  const txt=k=>String(input[k]??'').trim().slice(0,100);
  const integer=(key,min,max)=>{let raw=txt(key);if(!raw)return null;let x=Number(raw);if(!Number.isInteger(x)||x<min||x>max)throw Error(`Неверное значение: ${key}`);return x};
  const make=txt('make'),model=txt('model'),generation=txt('generation'),city=txt('city');
  if(!make&&!model)throw Error('Укажите марку или модель автомобиля.');
  if(city&&!/^[a-z0-9-]+$/.test(city))throw Error('В поле города используйте код из ссылки Авито, например kazan или moskva.');
  return {make,model,generation,city:city||'rossiya',year:integer('year',1886,2100),priceMax:integer('priceMax',1,1e10),mileageMax:integer('mileageMax',0,1e7),limit:integer('limit',1,30)||10};
}
function searchUrl(f){let u=new URL(`https://www.avito.ru/${f.city}/avtomobili`);u.searchParams.set('q',[f.make,f.model].filter(Boolean).join(' '));if(f.priceMax)u.searchParams.set('pmax',String(f.priceMax));return u.href}
async function ensureBrowser(){if(!context){context=await chromium.launchPersistentContext(path.join(__dirname,'.avito-profile'),{channel:'chrome',headless:false,viewport:{width:1280,height:900}});context.on('close',()=>{context=null});}return context;}
async function login(){let ctx=await ensureBrowser();let page=ctx.pages()[0]||await ctx.newPage();await page.goto('https://www.avito.ru/',{waitUntil:'domcontentloaded',timeout:45000});return {message:'Открылось окно Авито. Войдите в аккаунт при необходимости и вернитесь на портал.'}}
function blocked(text){return /доступ ограничен|подтвердите, что вы не робот|подозрительн.{0,15}активност|captcha/i.test(text)}
async function collect(f){
 let ctx=await ensureBrowser(), page=ctx.pages()[0]||await ctx.newPage(), found=[],seen=new Set();
 for(let n=1;n<=3 && found.length<f.limit;n++){
   let u=new URL(searchUrl(f));if(n>1)u.searchParams.set('p',String(n));
   let response=await page.goto(u.href,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1500);
   if(response&&response.status()>=400)throw Error(`Авито ответил ошибкой ${response.status()}. Проверьте открытое окно браузера.`);
   const text=await page.locator('body').innerText();if(blocked(text))throw Error('Авито запросил проверку. Пройдите её в открытом окне и повторите поиск.');
   const items=await page.locator('[data-marker="item"]').evaluateAll(nodes=>nodes.map(el=>{let a=el.querySelector('a[itemprop="url"],a[href*="_"]');let img=el.querySelector('img');let p=el.querySelector('[itemprop="price"]');return {url:a?.href,title:a?.innerText?.trim(),photo:img?.currentSrc||img?.src,price:p?.getAttribute('content')?Number(p.getAttribute('content')):null}}));
   if(!items.length){if(!found.length)throw Error('На странице не обнаружены объявления. Проверьте открытое окно Авито: разметка или условия доступа могли измениться.');break}
   let before=found.length;for(const item of items){if(validUrl(item.url)&&!seen.has(item.url)){seen.add(item.url);found.push(item);if(found.length>=f.limit)break}}if(before===found.length)break;
 }
 let cars=[];for(const item of found){
   let response=await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(900);
   if(response&&response.status()>=400)throw Error(`Авито ответил ошибкой ${response.status()}; поиск остановлен.`);
   let raw=await page.evaluate(()=>({title:document.querySelector('h1')?.innerText?.trim(),price:document.querySelector('[itemprop="price"]')?.getAttribute('content'),photo:document.querySelector('meta[property="og:image"]')?.content,text:document.body.innerText}));
   if(blocked(raw.text))throw Error('Авито запросил проверку. Пройдите её в открытом окне и повторите поиск.');
   if(!raw.title)throw Error('Не удалось прочитать страницу объявления; проверьте открытое окно Авито.');
   cars.push(normalize(raw,item));
 }
 return cars;
}
async function readBody(req){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>8192)throw Error('Слишком большой запрос');chunks.push(c)}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}
function reply(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))}
function createServer(deps={login,collect}){return http.createServer(async(req,res)=>{
 try{
  if(req.headers.host!==`${HOST}:${PORT}`){reply(res,403,{error:'Forbidden host'});return}
  if(req.method==='GET'&&req.url==='/'){let html=await fs.readFile(path.join(__dirname,'index.html'),'utf8');html=html.replace('</head>',`<meta name="local-token" content="${token}"></head>`);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return}
  if(req.method!=='POST'||!['/api/login','/api/search'].includes(req.url)){reply(res,404,{error:'Not found'});return}
  if(req.headers.origin!==BASE||req.headers['x-local-token']!==token){reply(res,403,{error:'Forbidden'});return}
  if(busy){reply(res,409,{error:'Сборщик уже выполняет запрос.'});return}busy=true;
  try{if(req.url==='/api/login')reply(res,200,await deps.login());else{const f=parseFilters(await readBody(req));const cars=await deps.collect(f);reply(res,200,{cars,filters:f})}}finally{busy=false}
 }catch(e){reply(res,400,{error:e.message})}
})}
if(require.main===module){createServer().listen(PORT,HOST,()=>{console.log(`Портал открыт: ${BASE}\nДля остановки закройте это окно.`);if(process.argv.includes('--open'))require('node:child_process').execFile('rundll32',['url.dll,FileProtocolHandler',BASE],()=>{});}).on('error',e=>console.error('Не удалось запустить локальный портал:',e.message));}
module.exports={parseFilters,searchUrl,createServer,BASE};
