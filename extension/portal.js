const $ = selector => document.querySelector(selector);
async function openPage(url) {
  const tab = await chrome.tabs.create({url,active:false});
  try {
    for(let attempt=0;attempt<120;attempt++){
      if((await chrome.tabs.get(tab.id)).status==='complete') return tab.id;
      await new Promise(done=>setTimeout(done,250));
    }
    throw Error('Страница не загрузилась за 30 секунд.');
  } catch(error){await chrome.tabs.remove(tab.id).catch(()=>{});throw error;}
}
async function read(url,func){
  const id=await openPage(url);
  let keep=false;
  try{
    const [entry]=await chrome.scripting.executeScript({target:{tabId:id},func});
    if(entry.result?.blocked){keep=true;await chrome.tabs.update(id,{active:true});throw Error('Авито запросил проверку доступа. После проверки повторите поиск.');}
    return entry.result;
  }finally{if(!keep)await chrome.tabs.remove(id).catch(()=>{});}
}
function listings(){
  if(/доступ ограничен|подтвердите, что вы не робот/i.test(document.body.innerText))return {blocked:true};
  const links=new Map();
  for(const card of document.querySelectorAll('[data-marker="item"]')){
    for(const a of card.querySelectorAll('a[href]')){
      const u=new URL(a.href),id=u.pathname.match(/_(\d+)\/?$/)?.[1];
      if(id && u.origin==='https://www.avito.ru' && u.pathname.includes('/avtomobili/')){links.set(id,u.origin+u.pathname);break;}
    }

  }
  const current=Number(new URL(location.href).searchParams.get('p') || 1);
  const nextPage=current+1;
  const next=[...document.querySelectorAll('a[href]')].some(link=>{
    const target=new URL(link.href);
    return target.origin===location.origin && target.pathname===location.pathname &&
      Number(target.searchParams.get('p'))===nextPage;
  });
  return {urls:[...links.values()],nextPage:next ? nextPage : null};
}
function details(){
  const text=document.body.innerText;
  if(/доступ ограничен|подтвердите, что вы не робот/i.test(text))return {blocked:true};
  const lines=text.split('\n').map(s=>s.trim());
  const field=(...labels)=>{
    for(let i=0;i<lines.length;i++){
      const at=lines[i].indexOf(':');
      if(at<0||!labels.includes(lines[i].slice(0,at).trim().toLowerCase()))continue;
      return lines[i].slice(at+1).trim()||lines[i+1]||null;
    }
    return null;
  };
  return {title:document.querySelector('h1')?.innerText,price:document.querySelector('[itemprop="price"]')?.getAttribute('content')||document.querySelector('[data-marker="item-view/item-price"]')?.innerText,photo:document.querySelector('meta[property="og:image"]')?.content,fields:{'Марка':field('марка'),'Модель':field('модель'),'Год':field('год выпуска'),'Поколение':field('поколение'),'Владельцы':field('владельцев по птс','владельцы'),'Пробег':field('пробег'),'Привод':field('привод'),'КПП':field('коробка передач','кпп'),'Климат':field('климат-контроль','климатическая установка'),'Цвет':field('цвет')}};
}
function parsePrice(value) {
  const match = String(value ?? '').trim().match(/^(\d+(?:[ \u00a0\u202f]\d{3})*)(?:[.,]00)?\s*(?:₽|руб\.?)?$/i);
  if (!match) return null;
  const price = Number(match[1].replace(/\s/g, ''));
  return Number.isSafeInteger(price) && price > 0 ? price : null;
}

function updateValuation(prices, total) {
  const sorted = prices.slice().sort((a, b) => a - b);
  $('#sample').textContent = 'Подходящих аналогов с ценой: ' + sorted.length + ' из ' + total +
    (sorted.length < 3 ? '. Для оценки нужны хотя бы три цены.' : sorted.length < 10 ? '. Малая выборка: оценка предварительная.' : '.');
  $('#bands').hidden = sorted.length < 3;
  if (sorted.length < 3) return;
  const amounts = document.querySelectorAll('#bands dd');
  [0.25, 0.5, 0.75].forEach((fraction, i) => {
    const index = (sorted.length - 1) * fraction;
    const lower = Math.floor(index);
    const amount = sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
    amounts[i].textContent = Math.round(amount).toLocaleString('ru-RU') + ' ₽';
  });
}

function words(value) {
  return String(value ?? '').toLowerCase().replace(/ё/g,'е').match(/[\p{L}\p{N}]+/gu)?.join(' ') || '';
}
function readVehicle() {
  return Object.fromEntries(['brand','model','year','km','gen','drive','gear','owners'].map(key => [key, $('#own-'+key).value.trim()]));
}
function comparable(car, own) {
  const f = car.fields;
  const identity = words(own.brand+' '+own.model);
  const named = f['Марка'] && f['Модель'];
  if (named ? words(f['Марка']+' '+f['Модель']) !== identity : !(' '+words(car.title)+' ').includes(' '+identity+' ')) return false;
  const year = String(f['Год'] || car.title).match(/\b(?:19|20)\d{2}\b/);
  const km = String(f['Пробег'] ?? '').replace(/\s/g,'').match(/^(\d+)(?:км)?$/i);
  if (!year || !km || Math.abs(Number(year[0])-Number(own.year)) > 1) return false;
  if (Math.abs(Number(km[1])-Number(own.km)) > Math.max(10000,Number(own.km)*0.2)) return false;
  return [['gen','Поколение'],['drive','Привод'],['gear','КПП'],['owners','Владельцы']].every(([key,label]) =>
    !own[key] || (' '+words(f[label])+' ').includes(' '+words(own[key])+' '));
}

function show(car,url){
  const article=document.createElement('article'),link=document.createElement('a');
  link.href=url;link.target='_blank';link.rel='noopener';link.textContent=car.title;article.append(link);
  if(car.photo?.startsWith('https://')){const img=document.createElement('img');img.src=car.photo;img.alt='Фото автомобиля';article.prepend(img);}
  for(const [label,value] of Object.entries({'Цена, ₽':car.price,...car.fields})){const row=document.createElement('div');row.textContent=label+' · '+(value||'—');article.append(row);}
  $('main').append(article);
}
$('form').onsubmit=async event=>{
  const prices = [];
  $('#valuation').hidden = false;
  updateValuation(prices, 0);
  event.preventDefault();$('button').disabled=true;$('main').replaceChildren();
  try{
    const own = readVehicle();
    const supplied = $('#url').value.trim();
    const u = new URL(supplied || 'https://www.avito.ru/all/avtomobili');
    if (!supplied) u.searchParams.set('q', own.brand+' '+own.model);
    if(u.origin!=='https://www.avito.ru'||u.username||u.password||u.pathname.split('/')[2]!=='avtomobili')throw Error('Введите ссылку на выдачу автомобилей www.avito.ru.');
    $('#status').textContent='Открываю выдачу…';
    const seen=new Set();
    let skipped=0;
    do {
      const page=await read(u.href,listings);
      if(!page.urls.length)throw Error('На странице не найдены карточки. Показано отчётов: '+$('main').children.length);
      for(const url of page.urls){
        const id=new URL(url).pathname.match(/_(\d+)\/?$/)?.[1];
        if(seen.has(id))continue;
        seen.add(id);
        $('#status').textContent='Страница '+(u.searchParams.get('p')||1)+' · Обработано: '+seen.size;
        try{
          const car=await read(url,details);
          if(!car?.title){skipped++;continue;}
          const matches = comparable(car, own);
          show(car,url);
          const note = document.createElement('strong');
          note.textContent = matches ? 'Подходит для сравнения' : 'Вне сравнения';
          $('main').lastElementChild.append(note);
          const price = parsePrice(car.price);
          if (matches && price !== null) prices.push(price);
          updateValuation(prices, $('main').children.length);
        }catch(error){
          if(error.message.includes('проверку доступа'))throw error;
          skipped++;
        }
      }
      if(!page.nextPage)break;
      u.searchParams.set('p',String(page.nextPage));
    }while(true);
    $('#status').textContent='Готово. Отчётов: '+$('main').children.length+' · Пропущено: '+skipped;
  }catch(e){$('#status').textContent=e.message;}finally{$('button').disabled=false;}
};
