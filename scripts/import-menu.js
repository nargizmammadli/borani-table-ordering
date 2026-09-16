// Imports the menu from Borani's current online menu (AZ / EN / RU) into data/menu.json
// and downloads the photos into public/img.
//
//   node scripts/import-menu.js          -> demo selection (a few items per category)
//   node scripts/import-menu.js --all    -> the whole menu
//
// Pizzas listed once per size ("Margarita 15cm", "Margarita 22cm"...) are merged
// into one item with a size choice.

const fs = require('fs');
const path = require('path');

const SITE = 'https://fevvareler-menu.borani.az';
const STORE_URL = `${SITE}/index.php?route=store/store&store_id=70`;
const LANGS = { az: 'az-az', en: 'en-gb', ru: 'ru-ru' };
const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'public', 'img');

// Tab pane 483 = "Menu" (kitchen), 498 = "Bar" (drinks + desserts, handled by reception)
const BAR_PANE = '498';
const CATEGORY_ORDER = [
  '485', '484', '486', '487', '488', '489', '490', '491', '492', '493', '494', '495', '496', '497', '563',
  '871', '499', '500', '501', '502',
];
const QUICK_NOTES = { '499': 'drink', '500': 'drink', '501': 'drink', '871': 'drink', '502': 'dessert' };

// Demo selection: product ids per category (for sized items, any one of the size ids is enough)
const DEMO_PICK = {
  '485': ['4142', '4143', '4144', '4145'],
  '484': ['4250', '4254', '4251', '4245'],
  '486': ['4271', '4274', '4273', '4272'],
  '487': ['4266', '4265', '4268', '4264'],
  '488': ['4216', '4219', '4221', '4215'],
  '489': ['4213', '4209', '4211', '4210'],
  '490': ['4259', '4258'],
  '491': ['4275', '4276', '4277'],
  '492': ['4260', '4261', '4262'],
  '493': ['4244', '4241', '4239', '4238'],
  '494': ['4150', '1320', '1322', '1330'],
  '495': ['4205', '4200', '4196', '4201', '4189'],
  '496': ['4167', '4172', '4156', '4162'],
  '497': ['4237', '4236', '4235'],
  '563': ['4185', '4183', '4186', '4182', '4181'],
  '871': ['4303', '4308', '4307'],
  '499': ['1864', '1340', '1351', '1832', '1838'],
  '500': ['1887', '1421', '1305', '1318'],
  '501': ['4301', '4300', '4302', '4296'],
  '502': ['4278', '4289', '4286', '4288', '4293'],
};

// Items whose name hides a choice ("bitter / normal") become one item with options
const OPTION_OVERRIDES = {
  '4266': {
    name: { az: 'Toyuq qanadı', en: 'Chicken wings', ru: 'Куриные крылышки' },
    options: [
      { az: 'Acılı', en: 'Spicy', ru: 'Острые' },
      { az: 'Acısız', en: 'Not spicy', ru: 'Не острые' },
    ],
  },
};

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function fetchPage(langCode) {
  const cookies = new Map();
  const keep = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

  keep(await fetch(STORE_URL));
  const form = new FormData();
  form.set('code', langCode);
  form.set('redirect', STORE_URL);
  keep(
    await fetch(`${SITE}/index.php?route=common/language/language`, {
      method: 'POST',
      body: form,
      headers: { cookie: cookieHeader() },
      redirect: 'manual',
    })
  );
  const res = await fetch(STORE_URL, { headers: { cookie: cookieHeader() } });
  return res.text();
}

function parsePage(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const cats = {};
  const paneRe = /id="main-tab-pane(\d+)"([\s\S]*?)(?=id="main-tab-pane\d+"|$)/g;
  let m;
  while ((m = paneRe.exec(html))) {
    const [, pane, body] = m;
    const tileRe = /data-categoryID="(\d+)" style="background-image: url\('([^']+)'\)">\s*<div class="category-item-text">([^<]*)</gi;
    let t;
    while ((t = tileRe.exec(body))) cats[t[1]] = { id: t[1], pane, image: t[2], name: decode(t[3]), products: [] };

    const groupRe = /products-items-(\d+)"[^>]*>\s*<div class="category-name">([^<]*)<\/div>([\s\S]*?)(?=<div class="category-products-items|$)/g;
    let g;
    while ((g = groupRe.exec(body))) {
      const cat = cats[g[1]] || (cats[g[1]] = { id: g[1], pane, name: decode(g[2]), products: [] });
      const prodRe = /data-productid="(\d+)">([\s\S]*?)(?=<div class="product-box"|$)/gi;
      let p;
      while ((p = prodRe.exec(g[3]))) {
        const b = p[2];
        const name = (b.match(/class="product-name">([^<]*)</) || [])[1];
        const recipe = (b.match(/class="product-recipe[^"]*">([^<]*)</) || [])[1] || '';
        const price = (b.match(/class="product-price">\s*([\d.,]+)/) || [])[1];
        const img = (b.match(/<img src="([^"]+)"/) || [])[1];
        if (!name || !price) continue;
        cat.products.push({
          id: p[1],
          name: decode(name),
          // Their list shows shortened ingredient lists ending in ".."
          recipe: decode(recipe).replace(/\.{2,}$/, '').trim(),
          price: Math.round(parseFloat(price.replace(',', '.')) * 100),
          image: img || null,
          soldOut: /class="product-name-items passive"/.test(b),
        });
      }
    }
  }
  return cats;
}

const SIZE_RE = /\s*(\d+)\s*(cm|sm|см)\s*$/i;

async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const localName = (url, folder) => {
  const parts = new URL(url).pathname.split('/');
  return `${folder}/${parts[parts.length - 2]}-${parts[parts.length - 1]}`;
};

async function main() {
  const all = process.argv.includes('--all');
  const pages = {};
  for (const [lang, code] of Object.entries(LANGS)) {
    console.log(`Fetching ${code}...`);
    pages[lang] = parsePage(await fetchPage(code));
  }

  const downloads = [];
  const categories = [];
  const items = [];

  for (const catId of CATEGORY_ORDER) {
    const en = pages.en[catId];
    if (!en) continue;
    const pick = all ? null : DEMO_PICK[catId];
    if (!all && !pick) continue;

    const catImage = en.image ? localName(en.image, 'cat') : null;
    if (catImage) downloads.push([en.image, path.join(IMG_DIR, catImage)]);
    categories.push({
      id: catId,
      section: en.pane === BAR_PANE ? 'bar' : 'food',
      station: en.pane === BAR_PANE ? 'bar' : 'kitchen',
      quickNotes: QUICK_NOTES[catId] || 'food',
      name: { az: pages.az[catId]?.name, en: en.name, ru: pages.ru[catId]?.name },
      image: catImage ? `/img/${catImage}` : null,
    });

    // Merge products across languages, then group sizes
    const groups = new Map();
    for (const p of en.products) {
      const az = pages.az[catId].products.find((x) => x.id === p.id) || p;
      const ru = pages.ru[catId].products.find((x) => x.id === p.id) || p;
      const size = p.name.match(SIZE_RE);
      const key = size ? p.name.replace(SIZE_RE, '').toLowerCase() : `id:${p.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ p, az, ru, size: size ? parseInt(size[1], 10) : null });
    }

    for (const variants of groups.values()) {
      variants.sort((a, b) => (a.size || 0) - (b.size || 0));
      const ids = variants.map((v) => v.p.id);
      if (pick && !ids.some((id) => pick.includes(id))) continue;

      const first = variants[0];
      const strip = (s) => s.replace(SIZE_RE, '').trim();
      const imageUrl = first.p.image;
      const image = imageUrl ? localName(imageUrl, 'menu') : null;
      if (image) downloads.push([imageUrl, path.join(IMG_DIR, image)]);

      const item = {
        id: first.p.id,
        category: catId,
        name: { az: strip(first.az.name), en: strip(first.p.name), ru: strip(first.ru.name) },
        description: { az: first.az.recipe, en: first.p.recipe, ru: first.ru.recipe },
        price: Math.min(...variants.map((v) => v.p.price)),
        image: image ? `/img/${image}` : null,
        soldOut: variants.every((v) => v.p.soldOut),
      };

      if (variants.length > 1 && variants.every((v) => v.size)) {
        item.variants = variants.map((v) => ({
          id: v.p.id,
          label: { az: `${v.size} sm`, en: `${v.size} cm`, ru: `${v.size} см` },
          price: v.p.price,
        }));
      }

      const override = OPTION_OVERRIDES[first.p.id];
      if (override) {
        item.name = override.name;
        item.variants = override.options.map((label, i) => ({ id: `${first.p.id}-${i + 1}`, label, price: first.p.price }));
      }
      items.push(item);
    }
  }

  console.log(`Downloading ${downloads.length} images...`);
  const unique = [...new Map(downloads.map((d) => [d[1], d])).values()];
  await Promise.all(unique.map(([url, dest]) => download(url, dest).catch((e) => console.warn('  image failed:', e.message))));
  await download(`${SITE}/image/cache/catalog/restorants/borani/logo-cr-82x82.jpg`, path.join(IMG_DIR, 'logo.jpg'));
  await download(`${SITE}/image/cache/catalog/restorants/borani/boranitorq-cr-1200x500.jpg`, path.join(IMG_DIR, 'hero.jpg'));

  const menu = {
    restaurant: {
      name: 'Boranı Fəvvarələr',
      address: 'Mirzə İbrahimov 1',
      phone: '+994 55 505 57 87',
      serviceChargePercent: 10,
      currency: '₼',
    },
    importedAt: new Date().toISOString(),
    categories,
    items,
  };
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'menu.json'), JSON.stringify(menu, null, 2));
  console.log(`Saved ${categories.length} categories and ${items.length} items to data/menu.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
