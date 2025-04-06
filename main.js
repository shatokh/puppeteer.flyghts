import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Функция для генерации URL с заданными параметрами
function generateRyanairUrl(from, to, tripLength, adults, children, month) {
    const nightsFrom = tripLength - 1; // nightsFrom будет на 1 меньше
    const nightsTo = tripLength + 1;   // nightsTo будет на 1 больше

    // Генерация дат для вылета и возвращения
    const dateOut = `${month}-01`;  // Первый день месяца
    const dateIn = `${month}-30`;  // Последний день месяца

    const baseUrl = 'https://www.ryanair.com/us/en/fare-finder';

    return `${baseUrl}?originIata=${from}&destinationIata=${to}&isReturn=true&isMacDestination=false&promoCode=&adults=${adults}&teens=0&children=${children}&infants=0&dateOut=${dateOut}&dateIn=${dateIn}&daysTrip=${tripLength}&nightsFrom=${nightsFrom}&nightsTo=${nightsTo}&dayOfWeek=&isExactDate=false&outboundFromHour=00:00&outboundToHour=23:59&inboundFromHour=00:00&inboundToHour=23:59&priceValueTo=&currency=PLN`;
}

// Функция для получения данных о рейсах с указанного URL
async function fetchFlightData(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Ожидаем, пока завершится API-запрос с кодом 200
    const response = await page.waitForResponse(
        response => response.url().includes('roundTripFares') && response.status() === 200,
        { timeout: 60000 }
    );

    console.log('API запрос завершен успешно, получаем данные рейсов.');

    // Получаем тело ответа в формате JSON
    const jsonResponse = await response.json();

    return jsonResponse.fares;
}

function writeCSV(results) {
    const csv = [
        ['Outbound Flight', 'Return Flight', 'Outbound Price', 'Return Price', 'Total Price'],
        ...results.map(fare => [
            `${fare.outbound.departureDate} - ${fare.outbound.arrivalDate} (${fare.outbound.departureAirport.name} -> ${fare.outbound.arrivalAirport.name})`,
            `${fare.inbound.departureDate} - ${fare.inbound.arrivalDate} (${fare.inbound.departureAirport.name} -> ${fare.inbound.arrivalAirport.name})`,
            `${fare.outbound.price.value} ${fare.outbound.price.currencyCode}`,
            `${fare.inbound.price.value} ${fare.inbound.price.currencyCode}`,
            `${fare.summary.price.value} ${fare.summary.price.currencyCode}`
        ]),
    ].map(row => row.join(',')).join('\n');

    console.log("\nБудет записано в файл:\n");
    console.log(csv);

    const uniqueFilename = generateUniqueFilename();
    const filePath = path.resolve(__dirname, uniqueFilename); // Correctly resolve the path

    try {
        fs.writeFileSync(filePath, csv, 'utf8');
        console.log(`\nCSV-файл успешно создан: ${filePath}`);
    } catch (error) {
        console.error('Ошибка при записи файла:', error);
    }
}

// Главная логика
(async () => {
    const config = JSON.parse(fs.readFileSync('./routes.json', 'utf8'));
    const { tripLength, month, routes, output, adults, children } = config;

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    let allResults = [];  // Массив для всех результатов

    // Обрабатываем каждый маршрут
    for (const route of routes) {
        console.log(`Генерация URL для маршрута: ${route.from} → ${route.to}`);
        const url = generateRyanairUrl(route.from, route.to, tripLength, adults, children, month);
        console.log(`Переходим по URL: ${url}`);

        const flightData = await fetchFlightData(page, url);
        allResults = [...allResults, ...flightData]; // Добавляем данные в общий массив

        console.log(`Обработка маршрута ${route.from} → ${route.to} завершена.`);
    }

    await browser.close();

    // Сортировка и вывод топ-3
    const top3 = allResults.sort((a, b) => a.summary.price.value - b.summary.price.value).slice(0, 3); // Сортировка по возрастанию и выбор первых 3
    console.log('\nТоп 3 самых дешевых рейса:');
    top3.forEach((fare, i) => {
        console.log(`Рейс ${i + 1}:`);
        console.log(`Туда:`);
        console.log(`Вылет: ${fare.outbound.departureDate}, ${fare.outbound.departureAirport.name}`);
        console.log(`Прилет: ${fare.outbound.arrivalDate}, ${fare.outbound.arrivalAirport.name}`);
        console.log(`Цена: ${fare.outbound.price.value} ${fare.outbound.price.currencyCode}`);
        console.log(`Обратно:`);
        console.log(`Вылет: ${fare.inbound.departureDate}, ${fare.inbound.departureAirport.name}`);
        console.log(`Прилет: ${fare.inbound.arrivalDate}, ${fare.inbound.arrivalAirport.name}`);
        console.log(`Цена: ${fare.inbound.price.value} ${fare.inbound.price.currencyCode}`);
        console.log(`Общая цена: ${fare.summary.price.value} ${fare.summary.price.currencyCode}`);
    });

    // Экспортируем результаты в CSV
    if (output === 'csv') {
        writeCSV(allResults);  // Записываем все результаты, а не только топ-3
    }
})();
