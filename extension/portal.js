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
    if(links.size===3)break;
  }
  return [...links.values()];
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
  return {title:document.querySelector('h1')?.innerText,price:document.querySelector('[itemprop="price"]')?.getAttribute('content')||document.querySelector('[data-marker="item-view/item-price"]')?.innerText,photo:document.querySelector('meta[property="og:image"]')?.content,fields:{'Год':field('год выпуска'),'Поколение':field('поколение'),'Владельцы':field('владельцев по птс','владельцы'),'Пробег':field('пробег'),'Привод':field('привод'),'КПП':field('коробка передач','кпп'),'Климат':field('климат-контроль','климатическая установка'),'Цвет':field('цвет')}};
}
function show(car,url){
  const article=document.createElement('article'),link=document.createElement('a');
  link.href=url;link.target='_blank';link.rel='noopener';link.textContent=car.title;article.append(link);
  if(car.photo?.startsWith('https://')){const img=document.createElement('img');img.src=car.photo;img.alt='Фото автомобиля';article.prepend(img);}
  for(const [label,value] of Object.entries({'Цена, ₽':car.price,...car.fields})){const row=document.createElement('div');row.textContent=label+' · '+(value||'—');article.append(row);}
  $('main').append(article);
}
$('form').onsubmit=async event=>{
  event.preventDefault();$('button').disabled=true;$('main').replaceChildren();
  try{
    const u=new URL($('#url').value.trim());
    if(u.origin!=='https://www.avito.ru'||u.username||u.password||u.pathname.split('/')[2]!=='avtomobili')throw Error('Введите ссылку на выдачу автомобилей www.avito.ru.');
    $('#status').textContent='Открываю выдачу…';
    const urls=await read(u.href,listings);
    if(!urls?.length)throw Error('Карточки в выдаче не найдены. Проверьте ссылку и наличие результатов.');
    for(const url of urls){const car=await read(url,details);if(!car?.title)throw Error('Не удалось прочитать заголовок карточки.');show(car,url);}
    $('#status').textContent='Объявлений: '+$('main').children.length;
  }catch(e){$('#status').textContent=e.message;}finally{$('button').disabled=false;}
};
