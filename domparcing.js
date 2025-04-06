import puppeteer from 'puppeteer';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import fs from 'fs';
import path from 'path';

// Функция для создания уникального имени файла с датой и временем
function generateUniqueFilename() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear()).slice(-2); // последние две цифры года
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    return `ryanair_results_${day}${month}${year}_${hours}${minutes}.csv`;
}

// Получаем путь к текущей директории в ES-модуле
const __dirname = new URL('.', import.meta.url).pathname;

// Функция для генерации всех возможных пар дат
function generateDatePairs(month, tripLength) {
    const [year, mon] = month.split('-').map(Number);
    const start = new Date(year, mon - 1, 1);
    const end = new Date(year, mon, 0);

    const pairs = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ret = new Date(d);
        ret.setDate(ret.getDate() + tripLength);
        if (ret > end) break;
        const depart = d.toISOString().split('T')[0];
        const retDate = ret.toISOString().split('T')[0];
        pairs.push({ depart, return: retDate });
    }
    return pairs;
}

// Функция для получения цены рейса
async function findFlightPrice(page, from, to, date) {
    try {
        await page.goto('https://www.ryanair.com', { waitUntil: 'domcontentloaded' });

        // Ожидаем появления индикатора загрузки и его исчезновения
        await page.waitForSelector('.shell__spinner', { visible: true });
        await page.waitForSelector('.shell__spinner', { hidden: true }); // Ждем, пока индикатор загрузки исчезнет

        // Теперь можно искать основной виджет поиска
        await page.waitForSelector('[data-ref="flight-search-widget"]', { timeout: 60000 }); // Увеличили таймаут до 60 секунд

        // Очищаем поля ввода
        await page.evaluate(() => {
            document.querySelector('[data-ref="input-button__departure"]').value = '';
            document.querySelector('[data-ref="input-button__destination"]').value = '';
        });

        // Вводим данные
        await page.type('[data-ref="input-button__departure"]', from);
        await page.keyboard.press('Enter');
        await page.type('[data-ref="input-button__destination"]', to);
        await page.keyboard.press('Enter');

        // Выбираем дату
        await page.click('[data-ref="date-input-button__dates-from"]');
        await page.waitForSelector(`[aria-label="${date}"]`, { timeout: 5000 });
        await page.click(`[aria-label="${date}"]`);
        await page.click('[data-ref="flight-search-widget__cta"]');

        await page.waitForSelector('.fare-card', { timeout: 10000 });

        // Получаем цену
        const price = await page.$eval('.fare-card .fare-card__price', el =>
            parseFloat(el.textContent.replace(/[^\d,]/g, '').replace(',', '.'))
        );

        return price;
    } catch (err) {
        console.error(`Ошибка при получении цены для ${from} → ${to}, дата: ${date}`, err);
        return null;
    }
}

// Функция для обработки одного маршрута
async function processRoute(page, route, datePairs) {
    const routeResults = [];

    for (const { depart, return: ret } of datePairs) {
        console.log(`Проверка рейса: ${route.from} → ${route.to}, дата: ${depart} → ${ret}`);

        const priceTo = await findFlightPrice(page, route.from, route.to, depart);
        if (!priceTo) continue;

        const priceBack = await findFlightPrice(page, route.to, route.from, ret);
        if (!priceBack) continue;

        routeResults.push({
            from: route.from,
            to: route.to,
            depart,
            return: ret,
            priceTo,
            priceBack,
            total: priceTo + priceBack
        });
    }

    return routeResults;
}

// Функция для записи данных в CSV файл
function writeCSV(results) {
    const csv = [
        ['From', 'To', 'Depart', 'Return', 'Price To', 'Price Back', 'Total'],
        ...results.map(r => [
            r.from,
            r.to,
            r.depart,
            r.return,
            r.priceTo.toFixed(2),
            r.priceBack.toFixed(2),
            r.total.toFixed(2)
        ])
    ].map(row => row.join(',')).join('\n');

    const uniqueFilename = generateUniqueFilename();
    const filePath = path.join(__dirname, uniqueFilename);
    fs.writeFileSync(filePath, csv, 'utf8');
    console.log(`\nCSV-файл успешно создан: ${filePath}`);
}

// Главная логика
(async () => {
    const config = JSON.parse(fs.readFileSync('./routes.json', 'utf8'));
    const { tripLength, month, routes, output } = config;

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    const datePairs = generateDatePairs(month, tripLength);
    let allResults = [];

    // Обрабатываем каждый маршрут
    for (const route of routes) {
        console.log(`Начинаю обработку маршрута: ${route.from} → ${route.to}`);
        const routeResults = await processRoute(page, route, datePairs);
        allResults = [...allResults, ...routeResults];
        console.log(`Обработка маршрута ${route.from} → ${route.to} завершена.`);
    }

    await browser.close();

    // Сортировка и вывод топ-3
    const top3 = allResults.sort((a, b) => a.total - b.total).slice(0, 3);
    console.log('\nТоп 3 маршрута:');
    top3.forEach((r, i) => {
        console.log(`${i + 1}) ${r.from} → ${r.to} | ${r.depart} → ${r.return} | €${r.priceTo.toFixed(2)} + €${r.priceBack.toFixed(2)} = €${r.total.toFixed(2)}`);
    });

    // Экспортируем результаты
    if (output === 'google') {
        const doc = new GoogleSpreadsheet('<SPREADSHEET_ID>');
        await doc.useServiceAccountAuth(creds);
        await doc.loadInfo();

        const sheet = doc.sheetsByTitle['Ryanair Roundtrips'] || await doc.addSheet({
            title: 'Ryanair Roundtrips',
            headerValues: ['From', 'To', 'Depart', 'Return', 'Price To', 'Price Back', 'Total']
        });

        await sheet.clearRows();
        await sheet.addRows(allResults);
        console.log('\nВсе данные записаны в Google Таблицу.');
    } else if (output === 'csv') {
        writeCSV(allResults); // Вызов функции записи в CSV
    } else {
        console.error('\nОшибка: неизвестный тип вывода. Укажи "csv" или "google" в routes.json');
    }
})();
