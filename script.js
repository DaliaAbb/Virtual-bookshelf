// ?demo=1 fills the app with sample books and keeps them apart from real data.
// ?view=<name> picks the screen and ?mode=day|night forces the picture (handy for testing).
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const STORAGE_KEY = DEMO ? 'bookshelf.demo.books' : 'bookshelf.books';
const GOALS_KEY = DEMO ? 'bookshelf.demo.goals' : 'bookshelf.goals';
const BOOKS_PER_ROW = 15;
const MIN_ROWS = 5; // shelf rows shown even when empty
const MAX_READING = 2;

// status: 'shelf' | 'reading' | 'archived'
let books = load(STORAGE_KEY, []);
let goals = load(GOALS_KEY, {}); // { "2026": 24 }
if (DEMO) {
    books = demoBooks();
    goals = { [new Date().getFullYear()]: 24 };
}

let view = 'shelf';
let statsYear = new Date().getFullYear();
let editingGoal = false;
const manualOpen = new Set();   // book ids whose "log time manually" form is open
let searchOpen = false;
let searchTerm = '';
const finishPrompt = new Set(); // book ids waiting for "move to archive?" confirmation

const $ = id => document.getElementById(id);
const shelfEl = $('shelf');
const panelEl = $('panel');
const toastEl = $('toast');
const titleEl = $('view-title');
const searchBox = $('search-input');
const addModal = $('add-modal');
const infoModal = $('info-modal');
const infoCard = $('info-card');
const shuffleBtn = $('shuffle-btn');

const VIEW_TITLES = {
    shelf: 'My Book Shelf',
    reading: 'Currently reading',
    archive: 'Archive',
    stats: 'Reading goal',
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- storage ----------
function load(key, fallback) {
    try {
        return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
        return fallback;
    }
}

function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
}

function saveGoals() {
    localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
}

// ---------- helpers ----------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function bookWidth(pages) {
    return clamp(14 + pages / 25, 14, 40);
}

function totalSeconds(book) {
    return book.sessions.reduce((sum, s) => sum + s.seconds, 0);
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

function formatClock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const pad = n => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const byStatus = status => books.filter(b => b.status === status);
const onShelf = () => byStatus('shelf');
const readingCount = () => byStatus('reading').length;
const findBook = id => books.find(b => b.id === id);

// Tiny DOM builder: h('div', { class: 'x', onClick: fn }, child, child...)
function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat().filter(k => k != null && k !== false));
    return el;
}

const btn = (label, onClick, cls = '') => h('button', { type: 'button', class: `btn-sm ${cls}`, onClick, text: label });

// Series stay together and in order; everything else by date added.
function sortedShelf() {
    const groupKey = b => (b.series ? `s:${b.series.toLowerCase()}` : `b:${b.id}`);
    const groupStart = {};
    for (const b of onShelf()) {
        const k = groupKey(b);
        groupStart[k] = Math.min(groupStart[k] ?? Infinity, b.addedAt);
    }
    return onShelf().sort((a, b) => {
        const ka = groupKey(a), kb = groupKey(b);
        if (ka !== kb) return groupStart[ka] - groupStart[kb];
        return (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0) || a.addedAt - b.addedAt;
    });
}

// A book can be shuffled only if no earlier, unfinished book in its series exists.
function shuffleCandidates() {
    return onShelf().filter(b => {
        if (!b.series || !b.seriesIndex) return true;
        return !books.some(o =>
            o.id !== b.id &&
            o.status !== 'archived' &&
            o.series && o.series.toLowerCase() === b.series.toLowerCase() &&
            (o.seriesIndex ?? Infinity) < b.seriesIndex
        );
    });
}

function toast(message, action = null) {
    toastEl.replaceChildren(message, ...(action ? [h('button', {
        type: 'button',
        class: 'toast-action',
        text: action.label,
        onClick: () => {
            toastEl.hidden = true;
            action.onClick();
        },
    })] : []));
    toastEl.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (toastEl.hidden = true), action ? 6000 : 2800);
}

// ---------- views ----------
function setView(next) {
    view = next;
    document.body.dataset.view = view;
    shelfEl.hidden = view !== 'shelf';
    panelEl.hidden = view === 'shelf';
    titleEl.textContent = VIEW_TITLES[view];
    render();
}

function render() {
    hideSpineCard();
    updateToolbar();
    searchBox.hidden = !searchOpen || !['shelf', 'archive'].includes(view);
    titleEl.hidden = !searchBox.hidden;
    if (view === 'shelf') {
        renderShelf();
    } else {
        panelEl.replaceChildren();
        panelEl.scrollTop = 0;
        ({ reading: renderReading, archive: renderArchive, stats: renderStats })[view]();
    }
    applySearch();
}

function updateToolbar() {
    document.querySelectorAll('[data-view]').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
    });
    const reading = document.querySelector('[data-view="reading"]');
    if (readingCount() > 0) reading.dataset.count = readingCount();
    else delete reading.dataset.count;
}

// ---------- shelf ----------
function renderShelf() {
    shelfEl.replaceChildren();
    const list = sortedShelf();

    // Always show at least MIN_ROWS shelves, adding rows as books overflow 20 per row.
    const rowCount = Math.max(MIN_ROWS, Math.ceil(list.length / BOOKS_PER_ROW));
    for (let r = 0; r < rowCount; r++) {
        const row = h('div', { class: 'shelf-row' });
        for (const book of list.slice(r * BOOKS_PER_ROW, (r + 1) * BOOKS_PER_ROW)) {
            row.append(bookElement(book));
        }
        const slot = h('div', { class: 'shelf-slot' }, row);
        shelfEl.append(slot);
        addRowLights(slot);
    }
}

const hashOf = str => [...str].reduce((sum, c) => sum + c.charCodeAt(0), 0);

// Light text on dark spines, dark text on light ones.
function textColorFor(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    const luminance = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return luminance > 0.62 ? '#2a1a10' : '#fff7e6';
}

function bookElement(book) {
    const el = h('div', {
        class: `book${book.status === 'archived' ? ' archived' : ''}`,
        'data-id': book.id,
        title: book.title,
        onClick: () => openInfo(book.id),
    }, h('span', { text: book.title }));
    el.style.width = `${bookWidth(book.pages)}px`;
    el.style.backgroundColor = book.color; // the shading and bands are layered on top in CSS
    el.style.color = textColorFor(book.color);
    el.style.height = `${46 + (hashOf(book.id) % 9)}px`; // slightly different heights, like real books

    if (book.status === 'shelf' && book.currentPage > 0) {
        const bar = h('i', { class: 'spine-progress' });
        bar.style.height = `${clamp((book.currentPage / book.pages) * 100, 0, 100)}%`;
        el.append(bar);
    }
    return el;
}

// ---------- book info ----------
function openInfo(id, { fromShuffle = false } = {}) {
    const book = findBook(id);
    if (!book) return;

    const archived = book.status === 'archived';
    const meta = [book.author, book.series && `${book.series}${book.seriesIndex ? ` #${book.seriesIndex}` : ''}`]
        .filter(Boolean).join(' · ');

    const colorInput = h('input', { type: 'color', value: book.color });
    colorInput.addEventListener('change', () => {
        book.color = colorInput.value;
        save();
        render();
    });

    infoCard.replaceChildren(...[
        h('h2', { text: book.title }),
        meta && h('p', { class: 'muted', text: meta }),
        h('p', { text: book.description || 'No description.' }),
        h('p', { text: `Nr. pages: ${book.pages}` }),
        h('p', { text: `Hours read: ${formatTime(totalSeconds(book))}` }),
        archived && h('p', { text: `Finished: ${new Date(book.finishedAt).toLocaleDateString()}` }),
        archived && ratingAndNote(book),
        h('label', { class: 'color-row' }, 'Color for book', colorInput),
        h('div', { class: 'row' },
            btn('Close', closeInfo),
            btn('Edit', () => openEdit(book.id, { fromShuffle })),
            archived
                ? btn('Back to shelf', () => unarchive(book.id))
                : [
                    fromShuffle && btn('Shuffle again', () => { closeInfo(); shuffle(); }),
                    btn('Start reading', () => startReading(book.id)),
                    btn('Done ✓', () => openFinishDialog(book.id, document.querySelector(`.book[data-id="${book.id}"]`))),
                ],
        ),
        deleteControl(book),
    ].filter(Boolean));
    infoModal.hidden = false;
}

// Edit a book's details. Reading time, the current page and the shelf position are kept.
function openEdit(id, { fromShuffle = false } = {}) {
    const book = findBook(id);
    if (!book) return;

    const field = (name, props = {}) => h('input', { name, ...props });
    const title = field('title', { placeholder: 'Name', required: true, value: book.title });
    const author = field('author', { placeholder: 'Author', value: book.author });
    const description = h('textarea', { name: 'description', rows: 3, placeholder: 'Description', text: book.description });
    const pages = field('pages', { type: 'number', min: 1, placeholder: 'Nr. pages', required: true, value: book.pages });
    const series = field('series', { placeholder: 'Series (optional)', value: book.series ?? '' });
    const seriesIndex = field('seriesIndex', { type: 'number', min: 1, placeholder: '#', value: book.seriesIndex ?? '' });
    const color = field('color', { type: 'color', value: book.color });

    const form = h('form', { class: 'edit-form' },
        h('h2', { text: 'Edit book' }),
        title, author, description, pages,
        h('div', { class: 'row' }, series, seriesIndex),
        h('label', { class: 'color-row' }, 'Color for book', color),
        h('div', { class: 'row' },
            btn('Cancel', () => openInfo(id, { fromShuffle }), 'ghost'),
            h('button', { type: 'submit', class: 'btn-sm', text: 'Save' })));

    form.addEventListener('submit', e => {
        e.preventDefault();
        const name = title.value.trim();
        const pageCount = Number.parseInt(pages.value, 10);
        if (!name || !(pageCount >= 1)) {
            toast('A book needs a name and a page count.');
            return;
        }
        book.title = name;
        book.author = author.value.trim();
        book.description = description.value.trim();
        book.pages = pageCount;
        book.currentPage = clamp(book.currentPage, 0, pageCount);
        book.color = color.value;
        const seriesName = series.value.trim();
        book.series = seriesName || null;
        book.seriesIndex = seriesName && seriesIndex.value ? Number(seriesIndex.value) : null;
        save();
        render();
        openInfo(id, { fromShuffle });
        toast('Saved.');
    });

    infoCard.replaceChildren(form);
    infoModal.hidden = false;
}

// An archived book keeps its rating and note; both can be changed here.
function ratingAndNote(book) {
    const note = h('textarea', { rows: 3, placeholder: 'Add a note or a favorite quote', text: book.note ?? '' });
    note.addEventListener('change', () => { book.note = note.value.trim(); save(); });
    return h('div', { class: 'review' },
        h('p', { class: 'muted', text: 'Your rating' }),
        starPicker(book.rating ?? 0, v => { book.rating = v || null; save(); }),
        note);
}

function closeInfo() {
    infoModal.hidden = true;
    document.querySelectorAll('.book.highlight').forEach(el => el.classList.remove('highlight'));
}

// "Delete" asks once more before removing the book for good.
function deleteControl(book) {
    const wrap = h('div', { class: 'row' });
    const idle = () => wrap.replaceChildren(btn('Delete', ask, 'danger-ghost'));
    const ask = () => wrap.replaceChildren(
        h('p', { text: 'Delete for good?' }),
        btn('Cancel', idle, 'ghost'),
        btn('Yes, delete', () => deleteBook(book.id), 'danger'),
    );
    idle();
    return wrap;
}

function deleteBook(id) {
    books = books.filter(b => b.id !== id);
    finishPrompt.delete(id);
    save();
    closeInfo();
    render();
}

// ---------- reading ----------
function startReading(id) {
    if (readingCount() >= MAX_READING) {
        toast(`You're already reading ${MAX_READING} books.`);
        return;
    }
    const book = findBook(id);
    book.status = 'reading';
    save();
    closeInfo();
    setView('reading');
}

function putBack(book) {
    if (book.timerStart || typeof book.pendingSeconds === 'number') {
        toast('Save or discard your reading session first.');
        return;
    }
    book.status = 'shelf';
    finishPrompt.delete(book.id);
    save();
    render();
}

function unarchive(id) {
    const book = findBook(id);
    book.status = 'shelf';
    book.finishedAt = null;
    book.currentPage = 0;
    save();
    closeInfo();
    render();
}

function toggleTimer(book) {
    if (book.timerStart) {
        book.pendingSeconds = Math.round((Date.now() - book.timerStart) / 1000);
        book.timerStart = null;
    } else {
        book.timerStart = Date.now();
    }
    save();
    render();
}

// The session is added on top of the book's earlier ones; the total is always their sum.
function saveSession(book, pageValue) {
    if (book.pendingSeconds > 0) {
        book.sessions.push({ date: Date.now(), seconds: book.pendingSeconds });
    }
    book.pendingSeconds = null;

    const page = Number.parseInt(pageValue, 10);
    if (!Number.isNaN(page)) book.currentPage = clamp(page, 0, book.pages);

    if (book.currentPage >= book.pages) finishPrompt.add(book.id);
    save();
    render();
}

// Reading time added by hand (when the timer was forgotten): becomes a normal session on the chosen day.
function logManual(book, { hours, minutes, date, page }) {
    const seconds = ((Number.parseInt(hours, 10) || 0) * 60 + (Number.parseInt(minutes, 10) || 0)) * 60;
    if (seconds <= 0) {
        toast('Enter how long you read.');
        return;
    }
    const [y, m, d] = date.split('-').map(Number);
    const when = date && y ? new Date(y, m - 1, d, 12).getTime() : Date.now();
    book.sessions.push({ date: Math.min(when, Date.now()), seconds });

    const pageNum = Number.parseInt(page, 10);
    if (!Number.isNaN(pageNum)) book.currentPage = clamp(pageNum, 0, book.pages);
    if (book.currentPage >= book.pages) finishPrompt.add(book.id);

    manualOpen.delete(book.id);
    save();
    render();
    toast(`Added ${formatTime(seconds)} to "${book.title}".`);
}

function manualForm(book) {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const hours = h('input', { type: 'number', min: 0, max: 24, value: 0 });
    const minutes = h('input', { type: 'number', min: 0, max: 59, value: 30 });
    const date = h('input', { type: 'date', max: iso, value: iso, class: 'wide' });
    const page = h('input', { type: 'number', min: 0, max: book.pages, value: book.currentPage });
    return h('div', { class: 'r-save' },
        h('p', { text: 'Add reading time' }),
        h('label', {}, 'Hours', hours),
        h('label', {}, 'Minutes', minutes),
        h('label', {}, 'Day', date),
        h('label', {}, 'Page reached', page),
        h('div', { class: 'row' },
            btn('Cancel', () => { manualOpen.delete(book.id); render(); }, 'ghost'),
            btn('Add', () => logManual(book, { hours: hours.value, minutes: minutes.value, date: date.value, page: page.value }))));
}

function discardSession(book) {
    book.pendingSeconds = null;
    save();
    render();
}

function askToFinish(book) {
    if (book.timerStart || typeof book.pendingSeconds === 'number') {
        toast('Save or discard your reading session first.');
        return;
    }
    finishPrompt.add(book.id);
    render();
}

function renderReading() {
    const list = byStatus('reading');
    if (list.length === 0) {
        panelEl.append(
            h('p', { class: 'empty', text: 'Nothing in progress. Shuffle or pick a book on the shelf and press "Start reading".' }),
            h('div', { class: 'row', style: 'justify-content:center' },
                btn('Go to shelf', () => setView('shelf'))),
        );
        return;
    }
    list.forEach(book => panelEl.append(readingCard(book)));
    panelEl.append(h('p', { class: 'empty', text: `${list.length} of ${MAX_READING} reading slots used` }));
}

function readingCard(book) {
    const pct = Math.round((book.currentPage / book.pages) * 100);
    const running = Boolean(book.timerStart);
    const pending = typeof book.pendingSeconds === 'number';

    const pageInput = h('input', { type: 'number', min: 0, max: book.pages, value: book.currentPage });
    pageInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') saveSession(book, pageInput.value);
    });

    const clockSeconds = running ? (Date.now() - book.timerStart) / 1000 : (pending ? book.pendingSeconds : 0);

    const card = h('section', { class: 'r-card', 'data-id': book.id },
        h('h3', { text: book.title }),
        h('p', { class: 'muted', text: [book.author, `${book.pages} pages`].filter(Boolean).join(' · ') }),
        book.description && h('p', { class: 'r-desc', text: book.description }),
        h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
        h('div', { class: 'r-meta' },
            h('span', { text: `p. ${book.currentPage} / ${book.pages} · ${pct}%` }),
            h('span', { text: `Total ${formatTime(totalSeconds(book))}` })),
        h('div', { class: 'timer-row' },
            h('span', { class: `clock${running ? ' running' : ''}`, 'data-timer': book.id, text: formatClock(clockSeconds) }),
            !pending && btn(running ? 'Stop' : 'Start', () => toggleTimer(book))),
        !running && !pending && !manualOpen.has(book.id) &&
            btn('+ Add time manually', () => { manualOpen.add(book.id); render(); }, 'ghost'),
        manualOpen.has(book.id) && !running && !pending && manualForm(book),
        pending && h('div', { class: 'r-save' },
            h('p', { text: 'Save this session?' }),
            h('label', {}, 'Page reached', pageInput),
            h('div', { class: 'row' },
                btn('Discard', () => discardSession(book), 'ghost'),
                btn('Save', () => saveSession(book, pageInput.value)))),
        finishPrompt.has(book.id) && h('div', { class: 'r-save' },
            h('p', { text: 'Finished! Move to archive?' }),
            h('div', { class: 'row' },
                btn('Not yet', () => { finishPrompt.delete(book.id); render(); }, 'ghost'),
                btn('Yes, archive', () => openFinishDialog(book.id, card)))),
        h('div', { class: 'row' },
            btn('Put back on shelf', () => putBack(book), 'ghost'),
            btn('Finish', () => askToFinish(book))),
        h('div', { class: 'row' }, btn('Edit info', () => openEdit(book.id), 'ghost')),
        deleteControl(book),
    );
    card.style.setProperty('--book', book.color);
    return card;
}

// Live timer display: only touches the clock text, never re-renders.
setInterval(() => {
    document.querySelectorAll('[data-timer]').forEach(el => {
        const book = findBook(el.dataset.timer);
        if (book?.timerStart) el.textContent = formatClock((Date.now() - book.timerStart) / 1000);
    });
}, 1000);

// ---------- finishing a book ----------
async function finishBook(id, sourceEl, { rating = null, note = '' } = {}) {
    const book = findBook(id);
    if (!book) return;
    if (sourceEl) await dissolve(sourceEl, book.color);

    book.rating = rating || null;
    book.note = note;
    book.status = 'archived';
    book.currentPage = book.pages;
    book.finishedAt = Date.now();
    book.timerStart = null;
    book.pendingSeconds = null;
    finishPrompt.delete(id);
    save();
    render();
    archiveArrived(book);
    chimeSound();
}

// Five clickable stars. Clicking the star that is already chosen clears the rating.
function starPicker(value, onChange) {
    const el = h('div', { class: 'stars' });
    const draw = () => el.replaceChildren(...[1, 2, 3, 4, 5].map(n =>
        h('button', {
            type: 'button',
            class: n <= value ? 'on' : '',
            title: `${n} star${n > 1 ? 's' : ''}`,
            text: n <= value ? '★' : '☆',
            onClick: () => { value = value === n ? 0 : n; onChange(value); draw(); },
        })));
    draw();
    return el;
}

// "How was it?": a rating and a note, then the book moves to the archive.
function openFinishDialog(id, sourceEl) {
    const book = findBook(id);
    if (!book) return;
    let rating = 0;
    const note = h('textarea', { rows: 3, placeholder: 'A note or a favorite quote (optional)' });
    infoCard.replaceChildren(
        h('h2', { text: 'Finished! 🎉' }),
        h('p', { class: 'muted', text: book.title }),
        h('p', { text: 'How was it?' }),
        starPicker(0, v => { rating = v; }),
        note,
        h('div', { class: 'row' },
            btn('Cancel', closeInfo, 'ghost'),
            btn('Move to archive', () => {
                closeInfo();
                finishBook(id, sourceEl ?? document.querySelector(`.book[data-id="${id}"]`), { rating, note: note.value.trim() });
            })),
    );
    infoModal.hidden = false;
    note.focus();
}

// Shown once the book has landed in the archive: the archive button pops, a "+1" floats up
// from it and a message offers to open the archive.
function archiveArrived(book) {
    const button = document.querySelector('[data-view="archive"]');
    button.classList.remove('bump');
    void button.offsetWidth; // restart the animation if it is already running
    button.classList.add('bump');

    const plus = h('span', { class: 'plus-one', text: '+1' });
    button.append(plus);
    setTimeout(() => plus.remove(), 1400);

    toast(`"${book.title}" is on your archive shelf.`, { label: 'View', onClick: () => setView('archive') });
}

// The element breaks into small particles that scatter and then stream to the Archive button.
function dissolve(el, color) {
    if (reducedMotion) return Promise.resolve();

    const rect = el.getBoundingClientRect();
    const targetRect = document.querySelector('[data-view="archive"]').getBoundingClientRect();
    const target = [targetRect.left + targetRect.width / 2, targetRect.top + targetRect.height / 2];

    const canvas = h('canvas', { class: 'particles' });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const cell = Math.max(2, Math.round(Math.sqrt(rect.width * rect.height) / 40));
    const particles = [];
    for (let x = 0; x < rect.width; x += cell) {
        for (let y = 0; y < rect.height; y += cell) {
            particles.push({
                x: rect.left + x, y: rect.top + y,
                curve: (Math.random() - 0.5) * 80, // how far the path bends sideways
                jx: (Math.random() - 0.5) * 30, jy: (Math.random() - 0.5) * 30, // a loose scatter at the start
                delay: Math.random() * 450,
                life: 1000 + Math.random() * 700,
                // mostly the book's color, with a few golden sparkles
                color: Math.random() < 0.12 ? '#ffe08a' : color,
            });
        }
    }

    el.style.visibility = 'hidden';
    document.body.append(canvas);

    return new Promise(resolve => {
        const start = performance.now();
        (function frame(now) {
            const t = now - start;
            ctx.clearRect(0, 0, innerWidth, innerHeight);
            let alive = false;
            for (const p of particles) {
                const age = t - p.delay;
                const u = Math.min(1, Math.max(0, age / p.life));
                if (age > p.life) continue;
                alive = true;

                const e = u * u * (3 - 2 * u); // slow start, quick finish
                const dx = target[0] - p.x, dy = target[1] - p.y;
                const dist = Math.hypot(dx, dy) || 1;
                const bend = Math.sin(Math.PI * e);
                const x = p.x + dx * e + (-dy / dist) * p.curve * bend + p.jx * bend;
                const y = p.y + dy * e + (dx / dist) * p.curve * bend + p.jy * bend;

                ctx.globalAlpha = u < 0.8 ? 1 : (1 - u) / 0.2;
                ctx.fillStyle = p.color;
                const size = cell * (1 - 0.5 * e);
                ctx.fillRect(x, y, size, size);
            }
            ctx.globalAlpha = 1;
            if (alive) requestAnimationFrame(frame);
            else {
                canvas.remove();
                resolve();
            }
        })(start);
    });
}

// ---------- archive ----------
function renderArchive() {
    const list = byStatus('archived').sort((a, b) => b.finishedAt - a.finishedAt);

    // Same painted shelves as the main shelf: newest first, up to BOOKS_PER_ROW books a row.
    const rowCount = Math.max(MIN_ROWS, Math.ceil(list.length / BOOKS_PER_ROW));
    for (let r = 0; r < rowCount; r++) {
        const row = h('div', { class: 'shelf-row' });
        list.slice(r * BOOKS_PER_ROW, (r + 1) * BOOKS_PER_ROW).forEach(b => row.append(bookElement(b)));
        if (list.length === 0 && r === 0) row.append(h('p', { class: 'empty', text: 'Finished books rest here. Nothing archived yet.' }));
        const slot = h('div', { class: 'shelf-slot' }, row);
        panelEl.append(slot);
        addRowLights(slot, ARCHIVE_LIGHTS);
    }
}

// ---------- yearly goal and stats ----------
const dayKey = t => {
    const d = new Date(t);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

// Consecutive days with at least one reading session, counting back from today.
function streakDays() {
    const days = new Set(books.flatMap(b => b.sessions).map(s => dayKey(s.date)));
    const d = new Date();
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(dayKey(d))) {
        n++;
        d.setDate(d.getDate() - 1);
    }
    return n;
}

function renderStats() {
    const year = statsYear;
    const thisYear = new Date().getFullYear();
    const finished = byStatus('archived').filter(b => new Date(b.finishedAt).getFullYear() === year);
    const goal = goals[year];
    const x = finished.length;

    const yearSeconds = books.flatMap(b => b.sessions)
        .filter(s => new Date(s.date).getFullYear() === year)
        .reduce((sum, s) => sum + s.seconds, 0);
    const pages = finished.reduce((sum, b) => sum + b.pages, 0);

    const prev = h('button', { type: 'button', text: '◀', onClick: () => { statsYear--; editingGoal = false; render(); } });
    const next = h('button', { type: 'button', text: '▶', disabled: year >= thisYear, onClick: () => { statsYear++; editingGoal = false; render(); } });

    const goalInput = h('input', { type: 'number', min: 1, placeholder: 'Books', value: goal ?? '' });
    const setGoal = () => {
        const n = Number.parseInt(goalInput.value, 10);
        if (!(n > 0)) return toast('Enter a goal above 0.');
        goals[year] = n;
        saveGoals();
        editingGoal = false;
        render();
    };
    goalInput.addEventListener('keydown', e => e.key === 'Enter' && setGoal());

    const reached = goal > 0 && x >= goal;
    panelEl.append(
        h('div', { class: 's-card' },
            h('div', { class: 'year-nav' }, prev, h('span', { text: String(year) }), next),
            h('div', { class: `ring-wrap${reached ? ' done' : ''}` }, goalRing(x, goal, year)),
            reached && h('p', { text: 'Goal reached! 🎉' }),
            (!goal || editingGoal)
                ? h('div', { class: 'goal-form' },
                    h('span', { text: `Goal for ${year}:` }), goalInput, btn('Set', setGoal))
                : btn('Edit goal', () => { editingGoal = true; render(); }),
        ),
        h('div', { class: 's-card' },
            h('div', { class: 'stat-grid' },
                stat(formatTime(yearSeconds), 'Total hours'),
                stat(String(pages), 'Total pages'),
                stat(`${streakDays()} 🔥`, 'Day streak'),
                stat(x ? formatTime(yearSeconds / x) : '–', 'Per book')),
            monthBars(finished),
        ),
        backupCard(),
    );
}

function stat(value, label) {
    return h('div', { class: 'stat' }, h('b', { text: value }), h('small', { text: label }));
}

function goalRing(x, goal, year) {
    const r = 44, c = 2 * Math.PI * r;
    const fill = goal > 0 ? clamp(x / goal, 0, 1) : 0;
    const svg = svgEl('svg', { viewBox: '0 0 120 120', width: 120, height: 120 });
    const gradient = svgEl('linearGradient', { id: 'ring-gradient', x1: 0, y1: 0, x2: 1, y2: 1 });
    gradient.append(
        svgEl('stop', { offset: '0%', style: 'stop-color: var(--btn-2)' }),
        svgEl('stop', { offset: '100%', style: 'stop-color: var(--accent-2)' }),
    );
    const defs = svgEl('defs');
    defs.append(gradient);
    svg.append(
        defs,
        svgEl('circle', { cx: 60, cy: 60, r, fill: 'none', style: 'stroke: var(--track)', 'stroke-width': 10 }),
        svgEl('circle', {
            cx: 60, cy: 60, r, fill: 'none', stroke: 'url(#ring-gradient)', 'stroke-width': 10,
            'stroke-linecap': 'round', 'stroke-dasharray': `${c * fill} ${c}`,
            transform: 'rotate(-90 60 60)',
        }),
    );
    const label = (y, size, text, weight = 400) => {
        const t = svgEl('text', { x: 60, y, 'text-anchor': 'middle', 'font-size': size, 'font-weight': weight, style: 'fill: var(--ink)' });
        t.textContent = text;
        return t;
    };
    svg.append(
        label(goal ? 64 : 68, 26, goal ? `${x}/${goal}` : String(x), 700),
        label(84, 9, goal ? `books read in ${year}` : 'no goal set yet'),
    );
    return svg;
}

function monthBars(finished) {
    const counts = Array(12).fill(0);
    finished.forEach(b => counts[new Date(b.finishedAt).getMonth()]++);
    const max = Math.max(1, ...counts);
    const svg = svgEl('svg', { viewBox: '0 0 168 56', width: '100%', height: 56 });
    counts.forEach((n, i) => {
        const bar = 36 * (n / max);
        svg.append(svgEl('rect', { x: i * 14 + 2, y: 40 - bar, width: 10, height: Math.max(bar, 1.5), rx: 2, style: `fill: var(${n ? '--btn-2' : '--track'})` }));
        const t = svgEl('text', { x: i * 14 + 7, y: 52, 'text-anchor': 'middle', 'font-size': 7, style: 'fill: var(--muted)' });
        t.textContent = 'JFMAMJJASOND'[i];
        svg.append(t);
    });
    return svg;
}

// ---------- shuffle ----------
let shuffling = false;

function shuffle() {
    if (shuffling) return;

    if (readingCount() >= MAX_READING) {
        toast(`You're already reading ${MAX_READING} books.`);
        return;
    }
    if (onShelf().length === 0) {
        toast('No books on your shelf. Add books first!');
        return;
    }
    const candidates = shuffleCandidates();
    if (candidates.length === 0) {
        toast('Nothing to pick right now. Finish the earlier book in your series first.');
        return;
    }
    if (view !== 'shelf') setView('shelf');

    const winner = candidates[Math.floor(Math.random() * candidates.length)];
    const els = [...document.querySelectorAll('.book')].filter(el =>
        candidates.some(c => c.id === el.dataset.id)
    );

    // Skip the highlight between candidate spines, then land on the winner.
    shuffling = true;
    shuffleBtn.disabled = true;
    let steps = 0;
    const totalSteps = 12;
    const timer = setInterval(() => {
        els.forEach(el => el.classList.remove('highlight'));
        steps++;
        const last = steps >= totalSteps;
        const el = last
            ? els.find(e => e.dataset.id === winner.id)
            : els[Math.floor(Math.random() * els.length)];
        el.classList.add('highlight');
        el.scrollIntoView({ block: 'nearest', inline: 'center' });
        if (last) {
            clearInterval(timer);
            shuffling = false;
            shuffleBtn.disabled = false;
            setTimeout(() => openInfo(winner.id, { fromShuffle: true }), 400);
        }
    }, 90);
}

// ---------- hover: pull the book forward so its whole name can be read ----------
// The spine only has room for a short vertical title, so while the pointer is on a book a larger
// card in the same color floats over it with the full name (fixed position: rows clip their children).
const spineCard = h('div', { class: 'spine-card', hidden: true });
document.body.append(spineCard);

let spineFor = null; // the book element the card is currently showing

function hideSpineCard() {
    spineFor = null;
    spineCard.hidden = true;
}

function showSpineCard(el, force = false) {
    if (!force && el === spineFor && !spineCard.hidden) return; // pointer just moved inside the same book
    const book = findBook(el.dataset.id);
    if (!book) return;
    spineFor = el;
    spineCard.textContent = book.title;
    spineCard.style.backgroundColor = book.color;
    spineCard.style.color = textColorFor(book.color);
    spineCard.hidden = false;

    // The card is never smaller than the spine under it, so the spine is fully covered (not seen behind it).
    const r = el.getBoundingClientRect();
    spineCard.style.minWidth = `${Math.ceil(r.width) + 8}px`;
    spineCard.style.minHeight = `${Math.ceil(r.height) + 10}px`;
    const w = spineCard.offsetWidth;
    const left = clamp(r.left + r.width / 2 - w / 2, 4, window.innerWidth - w - 4);
    spineCard.style.left = `${left}px`;
    spineCard.style.top = `${Math.max(4, r.bottom + 4 - spineCard.offsetHeight)}px`;
}

document.addEventListener('mouseover', e => {
    const el = e.target.closest?.('.book');
    if (el) showSpineCard(el);
    else hideSpineCard();
});
// Safety net: some ways of leaving (the draggable top strip, the book being redrawn or hidden) send no
// event, so while the card is up we keep checking that the pointer is still over its book.
setInterval(() => {
    if (spineCard.hidden) return;
    const under = pointer && document.elementFromPoint(...pointer)?.closest('.book');
    if (!spineFor?.isConnected || under !== spineFor) hideSpineCard();
}, 200);

// Leaving the books (or the whole window) puts the book back to normal.
function pointerLeft() {
    pointer = null;
    hideSpineCard();
}
document.documentElement.addEventListener('mouseleave', pointerLeft);
document.addEventListener('mouseout', e => { if (!e.relatedTarget) pointerLeft(); });
window.addEventListener('blur', pointerLeft);

// Scrolling moves the books under a pointer that stays still, so after every scroll the card follows
// whichever book is under the pointer now (and goes away if there is none).
let pointer = null;
let refreshQueued = false;
document.addEventListener('mousemove', e => { pointer = [e.clientX, e.clientY]; }, true);
document.addEventListener('scroll', () => {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
        refreshQueued = false;
        const el = pointer && document.elementFromPoint(...pointer)?.closest('.book');
        if (el) showSpineCard(el, true);
        else hideSpineCard();
    });
}, true);
document.addEventListener('click', hideSpineCard, true);

// ---------- search ----------
// Books that do not match fade out; the first match scrolls into view in its row. Works on the shelf
// and in the archive, and the query stays while you switch between them.
function applySearch() {
    const q = searchOpen ? searchTerm.trim().toLowerCase() : '';
    let first = null;
    let count = 0;
    document.querySelectorAll('.book.dim, .book.found').forEach(el => el.classList.remove('dim', 'found'));
    (view === 'archive' ? panelEl : shelfEl).querySelectorAll('.book').forEach(el => {
        const book = findBook(el.dataset.id);
        const hit = !q || [book?.title, book?.author, book?.series].some(t => t?.toLowerCase().includes(q));
        el.classList.toggle('dim', !hit);
        el.classList.toggle('found', Boolean(q) && hit);
        if (q && hit) {
            count++;
            first ??= el;
        }
    });
    if (first) first.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    return { q, count };
}

function setSearch(open) {
    searchOpen = open;
    if (!open) searchTerm = '';
    searchBox.value = searchTerm;
    render();
    if (open && !searchBox.hidden) searchBox.focus();
}

$('search-btn').addEventListener('click', () => {
    if (!['shelf', 'archive'].includes(view)) setView('shelf');
    setSearch(!searchOpen);
});
searchBox.addEventListener('input', () => {
    searchTerm = searchBox.value;
    const { q, count } = applySearch();
    if (q && count === 0) toast('No book with that name.');
});
searchBox.addEventListener('keydown', e => {
    if (e.key === 'Escape') setSearch(false);
});

// ---------- add book ----------
$('add-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const series = (f.get('series') || '').trim();

    books.push({
        id: crypto.randomUUID(),
        title: f.get('title').trim(),
        author: (f.get('author') || '').trim(),
        description: (f.get('description') || '').trim(),
        pages: Number(f.get('pages')),
        currentPage: 0,
        color: f.get('color'),
        series: series || null,
        seriesIndex: series && f.get('seriesIndex') ? Number(f.get('seriesIndex')) : null,
        status: 'shelf',
        sessions: [], // [{ date, seconds }]
        timerStart: null, // set while a reading session is running
        pendingSeconds: null, // a stopped session waiting to be saved
        addedAt: Date.now(),
        finishedAt: null,
    });

    save();
    e.target.reset();
    addModal.hidden = true;
    setView('shelf');
});

// ---------- fairy lights ----------
// One string of glowing bulbs hangs under every board. The shelf is pastel, the archive golden.
const NS = 'http://www.w3.org/2000/svg';
const SHELF_LIGHTS = ['#ffc2d1', '#d9c2ff', '#c2ecd9', '#fff3e0'];
const ARCHIVE_LIGHTS = ['#ffd27a', '#ffb454', '#fff0c2', '#f29e4c', '#ffe08a'];

function svgEl(name, attrs = {}) {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
}

// A glowing, twinkling bulb. `color` sets its glow through the --c variable.
function bulb(parent, x, y, r, color) {
    const el = svgEl('circle', { class: 'bulb', cx: x, cy: y, r });
    el.style.setProperty('--c', color);
    el.style.animationDelay = `${(Math.random() * 2.8).toFixed(2)}s`;
    parent.append(el);
}

// Points for a string hanging across `width`, sagging `sag` px in the middle.
function swag(width, y, sag, pad = 6) {
    const steps = Math.max(1, Math.round((width - 2 * pad) / 22));
    const points = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        points.push([pad + t * (width - 2 * pad), y + sag * Math.sin(Math.PI * t)]);
    }
    return points;
}

function addRowLights(slot, colors = SHELF_LIGHTS) {
    const points = swag(slot.clientWidth, 6, 6);
    const svg = svgEl('svg', { class: 'row-lights' });
    svg.append(svgEl('path', { class: 'wire', d: 'M' + points.map(p => p.join(',')).join(' L') }));
    points.forEach(([x, y], i) => bulb(svg, x, y, 3, colors[i % colors.length]));
    slot.append(svg);
}

// ---------- icons ----------
// If a PNG in assets/icons is missing, fall back to its emoji (the alt text).
document.querySelectorAll('.icon-btn img').forEach(img => {
    const fallback = () => img.replaceWith(img.alt);
    if (img.complete && img.naturalWidth === 0) fallback();
    else img.addEventListener('error', fallback);
});

// ---------- day and night ----------
// Two painted bookcases. The button next to the search icon switches between them and the choice is
// remembered (?mode=day|night forces one, handy for testing). Buttons and cards take the colors of
// the picture through CSS variables.
const MODE_KEY = 'bookshelf.mode';
const modeBtn = $('mode-btn');

function setMode(mode, { persist = true } = {}) {
    document.documentElement.dataset.mode = mode;
    // shows what a click switches to: the moon by day, the sun at night
    modeBtn.firstElementChild.src = `./assets/icons/${mode === 'day' ? 'lunar' : 'sun'}.png`;
    modeBtn.firstElementChild.alt = mode === 'day' ? '🌙' : '☀️';
    modeBtn.title = mode === 'day' ? 'Switch to night' : 'Switch to day';
    if (persist) {
        try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable: just don't remember it */ }
    }
}

let savedMode = null;
try { savedMode = localStorage.getItem(MODE_KEY); } catch { /* ignore */ }
const startMode = [params.get('mode'), savedMode].find(m => m === 'day' || m === 'night') ?? 'day';
setMode(startMode, { persist: false });
modeBtn.addEventListener('click', () => setMode(document.documentElement.dataset.mode === 'day' ? 'night' : 'day'));

// ---------- sample data for the preview page ----------
function demoBooks() {
    const year = new Date().getFullYear();
    const lastMonth = new Date().getMonth();
    const at = (month, day) => new Date(year, Math.min(month, lastMonth), day).getTime();
    const book = (n, title, author, pages, color, extra = {}) => ({
        id: `demo${n}`, title, author, description: '', pages, currentPage: 0, color,
        series: null, seriesIndex: null, status: 'shelf', sessions: [], timerStart: null, pendingSeconds: null,
        addedAt: n, finishedAt: null, ...extra,
    });
    const finished = (n, title, author, pages, color, month) => book(n, title, author, pages, color, {
        status: 'archived', currentPage: pages, finishedAt: at(month, 14),
        sessions: [{ date: at(month, 10), seconds: 3600 * (4 + (n % 5)) }],
    });
    const colors = ['#c0572b', '#2f6f8f', '#d9a441', '#6b3a5e', '#3f6b4a', '#d9728c', '#2b4c9b', '#b5372e', '#1e8a8a', '#7a5aa6', '#e08a3c', '#8a2d3b', '#8fb0a0', '#a63d6a'];
    const more = [
        ['Wolf Hall', 'Hilary Mantel', 650], ['The Remains of the Day', 'Kazuo Ishiguro', 258], ['Giovanni\'s Room', 'James Baldwin', 159],
        ['Middlemarch', 'George Eliot', 880], ['The Left Hand of Darkness', 'Ursula K. Le Guin', 304], ['Pachinko', 'Min Jin Lee', 496],
        ['Atonement', 'Ian McEwan', 351], ['Americanah', 'Chimamanda Adichie', 477], ['The Goldfinch', 'Donna Tartt', 771],
        ['Little Women', 'Louisa May Alcott', 449], ['Frankenstein', 'Mary Shelley', 280], ['The Bell Jar', 'Sylvia Plath', 244],
        ['Never Let Me Go', 'Kazuo Ishiguro', 288], ['Wide Sargasso Sea', 'Jean Rhys', 171], ['Emma', 'Jane Austen', 474],
        ['The Handmaid\'s Tale', 'Margaret Atwood', 311], ['Dracula', 'Bram Stoker', 418], ['Anna Karenina', 'Leo Tolstoy', 864],
        ['The Return of the Soldier', 'Rebecca West', 188], ['Sula', 'Toni Morrison', 192], ['Cloud Atlas', 'David Mitchell', 509],
        ['Jonathan Strange & Mr Norrell', 'Susanna Clarke', 782], ['Mrs Dalloway', 'Virginia Woolf', 194], ['Possession', 'A. S. Byatt', 555],
        ['The Bluest Eye', 'Toni Morrison', 224], ['Oryx and Crake', 'Margaret Atwood', 376], ['Small Things Like These', 'Claire Keegan', 116],
        ['Howl\'s Moving Castle', 'Diana Wynne Jones', 329], ['The Poppy War', 'R. F. Kuang', 544], ['Spinning Silver', 'Naomi Novik', 466],
    ].map(([title, author, pages], i) => book(100 + i, title, author, pages, colors[(i * 5 + 3) % colors.length]));

    return [
        ...more,
        book(1, 'Piranesi', 'Susanna Clarke', 272, '#2f6f8f'),
        book(2, 'Circe', 'Madeline Miller', 400, '#c0572b'),
        book(3, 'Dune', 'Frank Herbert', 612, '#d9a441'),
        book(4, 'Rebecca', 'Daphne du Maurier', 380, '#6b3a5e'),
        book(5, 'The Secret History', 'Donna Tartt', 559, '#3f6b4a'),
        book(6, 'Persuasion', 'Jane Austen', 249, '#d9728c'),
        book(7, 'Neuromancer', 'William Gibson', 271, '#2b4c9b'),
        book(8, 'Kindred', 'Octavia Butler', 287, '#b5372e'),
        book(9, 'A Wizard of Earthsea', 'Ursula K. Le Guin', 183, '#1e8a8a', { series: 'Earthsea', seriesIndex: 1 }),
        book(10, 'The Tombs of Atuan', 'Ursula K. Le Guin', 180, '#7a5aa6', { series: 'Earthsea', seriesIndex: 2 }),
        book(11, 'The Farthest Shore', 'Ursula K. Le Guin', 223, '#e08a3c', { series: 'Earthsea', seriesIndex: 3 }),
        book(12, 'Beloved', 'Toni Morrison', 324, '#8a2d3b'),
        book(13, 'Normal People', 'Sally Rooney', 266, '#8fb0a0'),
        book(14, 'Mexican Gothic', 'Silvia Moreno-Garcia', 301, '#a63d6a', { currentPage: 120 }),
        book(15, 'The Night Circus', 'Erin Morgenstern', 387, '#3a3a8c', {
            status: 'reading', currentPage: 140,
            description: 'Two young magicians are bound to a mysterious competition inside a circus that opens only at night.',
            sessions: [{ date: Date.now() - 86400000, seconds: 5400 }, { date: Date.now() - 3600000, seconds: 2700 }],
        }),
        book(16, 'Braiding Sweetgrass', 'Robin Wall Kimmerer', 391, '#5a8f3d', {
            status: 'reading', currentPage: 60,
            description: 'Indigenous wisdom, scientific knowledge and the teachings of plants.',
            sessions: [{ date: Date.now() - 2 * 86400000, seconds: 3000 }],
        }),
        finished(17, 'Klara and the Sun', 'Kazuo Ishiguro', 303, '#e3a72f', 0),
        finished(18, 'Station Eleven', 'Emily St. John Mandel', 333, '#2e7d9a', 1),
        finished(19, 'Jane Eyre', 'Charlotte Bronte', 532, '#7a2e4a', 3),
        finished(20, 'The Hobbit', 'J.R.R. Tolkien', 310, '#4a7c3b', 4),
        finished(21, 'Gideon the Ninth', 'Tamsyn Muir', 448, '#8a3ab9', 6),
        finished(22, 'Educated', 'Tara Westover', 352, '#c4572b', 8),
    ];
}

// ---------- sounds ----------
// One small synthesized sound (no audio file): a chime that plays when a book is finished.
let audio = null;

function audioContext() {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    return audio;
}

// Four soft bell notes rising, each with a quiet octave on top.
function chimeSound() {
    const c = audioContext();
    const t = c.currentTime;
    [659.25, 830.61, 987.77, 1318.51].forEach((freq, i) => {
        [[freq, 0.16], [freq * 2, 0.04]].forEach(([f, volume]) => {
            const osc = c.createOscillator();
            const gain = c.createGain();
            const start = t + i * 0.13;
            osc.type = 'sine';
            osc.frequency.value = f;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(volume, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 1.3);
            osc.connect(gain).connect(c.destination);
            osc.start(start);
            osc.stop(start + 1.4);
        });
    });
}

// ---------- backup ----------
// Export writes the whole library to one file; import replaces the library with such a file.
const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
document.body.append(importInput);

function exportBackup() {
    const today = new Date().toISOString().slice(0, 10);
    const backup = { app: 'bookshelf', version: 1, exportedAt: new Date().toISOString(), books, goals };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = h('a', { href: url, download: `bookshelf-backup-${today}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Backup ready: choose where to save it.');
}

// Keep only what a book needs, with safe defaults, so a hand-edited file cannot break the app.
function cleanBook(b) {
    const status = ['shelf', 'reading', 'archived'].includes(b.status) ? b.status : 'shelf';
    const pages = Math.max(1, Number(b.pages) || 1);
    return {
        id: String(b.id ?? crypto.randomUUID()),
        title: String(b.title).slice(0, 200),
        author: String(b.author ?? ''),
        description: String(b.description ?? ''),
        pages,
        currentPage: clamp(Number(b.currentPage) || 0, 0, pages),
        color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#ff889c',
        series: b.series ? String(b.series) : null,
        seriesIndex: b.seriesIndex ? Number(b.seriesIndex) : null,
        status,
        sessions: (Array.isArray(b.sessions) ? b.sessions : [])
            .filter(x => x && Number(x.seconds) > 0)
            .map(x => ({ date: Number(x.date) || Date.now(), seconds: Number(x.seconds) })),
        timerStart: null,
        pendingSeconds: null,
        addedAt: Number(b.addedAt) || Date.now(),
        finishedAt: status === 'archived' ? (Number(b.finishedAt) || Date.now()) : null,
        rating: clamp(Number(b.rating) || 0, 0, 5) || null,
        note: String(b.note ?? ''),
    };
}

importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    let data;
    try {
        data = JSON.parse(await file.text());
        if (!Array.isArray(data.books) || data.books.some(b => !b || typeof b.title !== 'string')) throw new Error('shape');
    } catch {
        toast("That file isn't a Book Shelf backup.");
        return;
    }
    const incoming = data.books.map(cleanBook);
    const incomingGoals = data.goals && typeof data.goals === 'object' ? data.goals : {};
    infoCard.replaceChildren(
        h('h2', { text: 'Restore backup?' }),
        h('p', { text: `This replaces your current library (${books.length} book${books.length === 1 ? '' : 's'}) with the ${incoming.length} book${incoming.length === 1 ? '' : 's'} in the backup.` }),
        h('div', { class: 'row' },
            btn('Cancel', closeInfo, 'ghost'),
            btn('Replace', () => {
                books = incoming;
                goals = incomingGoals;
                save();
                saveGoals();
                closeInfo();
                render();
                toast('Library restored.');
            })),
    );
    infoModal.hidden = false;
});

function backupCard() {
    return h('div', { class: 's-card backup' },
        h('p', { class: 'muted', text: 'Back up your library to a file, or restore one.' }),
        h('div', { class: 'row' },
            btn('Export', exportBackup),
            btn('Import', () => importInput.click())));
}

// ---------- wiring ----------
$('add-btn').addEventListener('click', () => (addModal.hidden = false));
shuffleBtn.addEventListener('click', shuffle);
$('close-btn').addEventListener('click', () => window.close());

// save data before closing the window
window.addEventListener('beforeunload', () => {
    save();
    saveGoals();
});
addModal.querySelector('[data-close]').addEventListener('click', () => (addModal.hidden = true));
document.querySelectorAll('[data-view]').forEach(b =>
    b.addEventListener('click', () => setView(b.dataset.view))
);

[addModal, infoModal].forEach(modal =>
    modal.addEventListener('click', e => {
        if (e.target !== modal) return;
        modal.hidden = true;
        closeInfo();
    })
);

// The picture scales with the window, so the books scale with it (60px is the shelf spacing of a 500px-tall window).
function fitBooks() {
    const pictureHeight = Math.max(innerHeight, innerWidth * 1.5);
    document.documentElement.style.setProperty('--book-zoom', ((pictureHeight * 0.1198) / 60 * 0.88).toFixed(3));
}
fitBooks();

// The lights are drawn to the row width: redraw them if the window size changes.
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        fitBooks();
        if (view === 'shelf' || view === 'archive') render();
    }, 120);
});

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    addModal.hidden = true;
    closeInfo();
});


const startView = params.get('view');
setView(VIEW_TITLES[startView] ? startView : 'shelf');

// Show the welcome page on a normal launch. Query-string preview modes can open
// the app directly, which keeps ?demo=1 and ?view=... useful while developing.
const welcomeScreen = $('welcome-screen');
const enterBtn = $('enter-btn');
const skipWelcome = params.has('demo') || params.has('view');

if (skipWelcome) {
    welcomeScreen.hidden = true;
} else {
    document.body.classList.add('welcome-open');
}

function enterLibrary() {
    if (!welcomeScreen || welcomeScreen.hidden) return;
    welcomeScreen.classList.add('is-leaving');
    window.setTimeout(() => {
        welcomeScreen.hidden = true;
        welcomeScreen.classList.remove('is-leaving');
        document.body.classList.remove('welcome-open');
    }, reducedMotion ? 0 : 430);
}

enterBtn.addEventListener('click', enterLibrary);
welcomeScreen.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target !== enterBtn) enterLibrary();
});
